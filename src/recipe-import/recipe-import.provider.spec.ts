import { BadRequestException } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { RecipeImportModelProvider } from './recipe-import.provider';

describe('RecipeImportModelProvider', () => {
    const values: Record<string, string> = {
        RECIPE_IMPORT_PROVIDER: 'deepseek',
        RECIPE_IMPORT_BASE_URL: 'https://api.deepseek.com',
        RECIPE_IMPORT_MODEL: 'deepseek-v4-flash',
        RECIPE_IMPORT_API_KEY: 'test-key',
    };
    const config = {
        get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
    };
    const provider = new RecipeImportModelProvider(config as never);

    afterEach(() => jest.restoreAllMocks());

    it('uses DeepSeek Chat Completions instead of the Responses endpoint', async () => {
        const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    intermediateRecipes: [
                                        {
                                            sourceName: '测试吐司',
                                            suggestedName: null,
                                            type: 'MAIN',
                                            category: 'BREAD',
                                            notes: null,
                                            yieldText: null,
                                            sections: [],
                                            products: [],
                                            procedure: [],
                                            evidence: null,
                                        },
                                    ],
                                    reviewItems: [],
                                }),
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        const result = await provider.analyze({ text: '高粉 500g，水 300g' }, '高筋小麦粉、水');

        expect(result.intermediateRecipes?.[0].sourceName).toBe('测试吐司');
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.deepseek.com/chat/completions',
            expect.objectContaining({ method: 'POST' }),
        );
        const request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
            model: string;
            response_format: { type: string };
            max_tokens: number;
            messages: Array<{ content: string }>;
        };
        expect(request.model).toBe('deepseek-v4-flash');
        expect(request.response_format).toEqual({ type: 'json_object' });
        expect(request.max_tokens).toBe(65536);
        expect(request.messages[0].content).toContain('示例 JSON 输出');
        expect(request.messages[0].content).toContain('不要计算最终 ratio');
    });

    it('returns a clear error for image input unsupported by DeepSeek', async () => {
        await expect(
            provider.analyze(
                {
                    fileName: 'recipe.png',
                    mimeType: 'image/png',
                    buffer: Buffer.from('image'),
                },
                '',
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('extracts JSON wrapped in DeepSeek thinking text and markdown fences', async () => {
        jest.spyOn(global, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                content:
                                    '<think>先分析配方结构</think>\n结果如下：\n```json\n{"intermediateRecipes":[],"reviewItems":[]}\n```',
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        );

        await expect(provider.analyze({ text: '测试配方' }, '')).resolves.toMatchObject({
            intermediateRecipes: [],
            reviewItems: [],
        });
    });

    it('retries once when DeepSeek returns an empty content', async () => {
        const fetchMock = jest
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        choices: [
                            {
                                finish_reason: 'stop',
                                message: { content: '{"intermediateRecipes":[],"reviewItems":[]}' },
                            },
                        ],
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        await expect(provider.analyze({ text: '测试配方' }, '')).resolves.toMatchObject({
            intermediateRecipes: [],
            reviewItems: [],
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const retryRequest = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string) as {
            max_tokens: number;
            messages: Array<{ content: string }>;
        };
        expect(retryRequest.max_tokens).toBe(65536);
        expect(retryRequest.messages[1].content).toContain('上一次响应为空或不是合法 JSON');
    });

    it('extracts xlsx cells locally before sending text to DeepSeek', async () => {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('吐司配方');
        worksheet.addRow(['原料', '克重']);
        worksheet.addRow(['高筋小麦粉', 500]);
        worksheet.addRow(['水', 300]);
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const fetchMock = jest
            .spyOn(global, 'fetch')
            .mockResolvedValue(
                new Response(
                    JSON.stringify({ choices: [{ message: { content: '{"intermediateRecipes":[],"reviewItems":[]}' } }] }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        await provider.analyze(
            {
                fileName: 'recipe.xlsx',
                mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                buffer,
            },
            '',
        );

        const request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
            messages: Array<{ role: string; content: string }>;
        };
        expect(request.messages[1].content).toContain('工作表：吐司配方');
        expect(request.messages[1].content).toContain('高筋小麦粉\t500');
        expect(request.messages[1].content).toContain('水\t300');
    });

    it('safely ignores empty merged follower cells in xlsx files', async () => {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('合并单元格配方');
        worksheet.mergeCells('A1:B1');
        worksheet.getCell('C1').value = '吐司配方';
        worksheet.addRow(['高筋小麦粉', 500]);
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const fetchMock = jest
            .spyOn(global, 'fetch')
            .mockResolvedValue(
                new Response(
                    JSON.stringify({ choices: [{ message: { content: '{"intermediateRecipes":[],"reviewItems":[]}' } }] }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                ),
            );

        await expect(
            provider.analyze(
                {
                    fileName: 'merged.xlsx',
                    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    buffer,
                },
                '',
            ),
        ).resolves.toMatchObject({ intermediateRecipes: [], reviewItems: [] });

        const request = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
            messages: Array<{ content: string }>;
        };
        expect(request.messages[1].content).toContain('吐司配方');
        expect(request.messages[1].content).toContain('高筋小麦粉\t500');
    });
});
