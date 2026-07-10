import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ExcelJS from 'exceljs';
import { ModelImportResult } from './recipe-import.types';

export interface RecipeImportSource {
    fileName?: string;
    mimeType?: string;
    buffer?: Buffer;
    text?: string;
}

@Injectable()
export class RecipeImportModelProvider {
    private readonly logger = new Logger(RecipeImportModelProvider.name);

    constructor(private readonly config: ConfigService) {}

    get providerName() {
        return this.config.get<string>('RECIPE_IMPORT_PROVIDER', 'openai-compatible');
    }

    get modelName() {
        return this.config.get<string>('RECIPE_IMPORT_MODEL', 'gpt-5.4-mini');
    }

    async analyze(source: RecipeImportSource, catalogContext: string): Promise<ModelImportResult> {
        const apiKey = this.config.get<string>('RECIPE_IMPORT_API_KEY') || this.config.get<string>('OPENAI_API_KEY');
        if (!apiKey) {
            if (process.env.NODE_ENV !== 'production') return this.createDevelopmentResult(source);
            throw new BadRequestException('智能导入尚未配置模型 API Key，请联系管理员。');
        }

        const baseUrl = this.config
            .get<string>('RECIPE_IMPORT_BASE_URL', 'https://api.openai.com/v1')
            .replace(/\/$/, '');
        if (this.providerName.toLowerCase() === 'deepseek') {
            return this.analyzeWithDeepSeek(source, catalogContext, baseUrl, apiKey);
        }

        return this.analyzeWithResponsesApi(source, catalogContext, baseUrl, apiKey);
    }

    private async analyzeWithResponsesApi(
        source: RecipeImportSource,
        catalogContext: string,
        baseUrl: string,
        apiKey: string,
    ) {
        const inputContent = this.buildResponsesInput(source, catalogContext);
        let response: Response;
        try {
            response = await this.fetchModel(`${baseUrl}/responses`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.modelName,
                    input: [{ role: 'user', content: inputContent }],
                    text: {
                        format: {
                            type: 'json_schema',
                            name: 'normalized_baking_recipe',
                            strict: true,
                            schema: this.outputSchema(),
                        },
                    },
                }),
            });
        } catch (error) {
            throw new BadGatewayException(
                `智能识别服务连接失败：${error instanceof Error ? error.message : '未知错误'}`,
            );
        }

        if (!response.ok) {
            const detail = await response.text();
            throw new BadGatewayException(`智能识别服务返回错误（${response.status}）：${detail.slice(0, 300)}`);
        }
        const payload = (await response.json()) as {
            output_text?: string;
            output?: Array<{ content?: Array<{ text?: string }> }>;
        };
        const outputText =
            payload.output_text ||
            payload.output?.flatMap((item) => item.content ?? []).find((item) => item.text)?.text;
        return {
            ...this.parseModelResult(outputText),
            diagnostics: { extractedText: source.text, rawModelOutput: outputText },
        };
    }

    private async analyzeWithDeepSeek(
        source: RecipeImportSource,
        catalogContext: string,
        baseUrl: string,
        apiKey: string,
    ) {
        const sourceText = await this.extractTextForDeepSeek(source);
        const instruction = `${this.buildInstruction(catalogContext)}\n你必须只输出 JSON 对象，不要输出 Markdown 或解释。\n\n示例输入：高筋面粉 500g，水 300g。\n示例 JSON 输出：\n${JSON.stringify(this.deepSeekJsonExample())}\n\n最终输出必须符合以下 JSON Schema：\n${JSON.stringify(this.outputSchema())}`;
        const configuredMaxTokens = this.getDeepSeekMaxTokens();
        let lastOutput = '';
        let lastFinishReason = '';

        for (let attempt = 0; attempt < 2; attempt++) {
            const maxTokens = Math.min(configuredMaxTokens * (attempt + 1), 65536);
            let response: Response;
            try {
                response = await this.fetchModel(`${baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.modelName,
                        messages: [
                            { role: 'system', content: instruction },
                            {
                                role: 'user',
                                content: `${attempt ? '上一次响应为空或不是合法 JSON。请务必返回非空、完整、可解析的 JSON 对象。\n\n' : ''}待识别内容：\n${sourceText}`,
                            },
                        ],
                        response_format: { type: 'json_object' },
                        thinking: { type: 'disabled' },
                        max_tokens: maxTokens,
                        stream: false,
                    }),
                });
            } catch (error) {
                throw new BadGatewayException(
                    `DeepSeek 连接失败：${error instanceof Error ? error.message : '未知错误'}`,
                );
            }

            if (!response.ok) {
                const detail = await response.text();
                throw new BadGatewayException(`DeepSeek 返回错误（${response.status}）：${detail.slice(0, 500)}`);
            }
            const payload = (await response.json()) as {
                choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
            };
            lastOutput = payload.choices?.[0]?.message?.content || '';
            lastFinishReason = payload.choices?.[0]?.finish_reason || '';
            if (lastOutput.trim()) {
                try {
                    return {
                        ...this.parseModelResult(lastOutput),
                        diagnostics: { extractedText: sourceText, rawModelOutput: lastOutput },
                    };
                } catch (error) {
                    if (attempt === 1) {
                        if (lastFinishReason === 'length')
                            throw new BadGatewayException(
                                `DeepSeek 输出因长度限制被截断，请提高 RECIPE_IMPORT_MAX_TOKENS（当前 ${configuredMaxTokens}）。`,
                            );
                        throw this.withDiagnostics(error, sourceText, lastOutput);
                    }
                }
            }
        }

        this.logger.error(
            `DeepSeek 连续两次返回空 content model=${this.modelName} finish_reason=${lastFinishReason || 'unknown'}`,
        );
        throw this.withDiagnostics(
            new BadGatewayException('DeepSeek 连续两次返回空内容，请稍后重试或调整配方识别提示词。'),
            sourceText,
            lastOutput,
        );
    }

    private async fetchModel(url: string, init: RequestInit) {
        const configured = Number(this.config.get<string>('RECIPE_IMPORT_TIMEOUT_MS', '240000'));
        const timeoutMs = Number.isFinite(configured)
            ? Math.min(Math.max(Math.trunc(configured), 10000), 600000)
            : 240000;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        this.logger.log(
            `模型请求开始 provider=${this.providerName} model=${this.modelName} timeoutMs=${timeoutMs} endpoint=${new URL(url).pathname}`,
        );
        try {
            const response = await fetch(url, { ...init, signal: controller.signal });
            this.logger.log(
                `模型响应头已到达 provider=${this.providerName} model=${this.modelName} status=${response.status} headerDurationMs=${Date.now() - startedAt}`,
            );
            return response;
        } catch (error) {
            const durationMs = Date.now() - startedAt;
            if (error instanceof Error && error.name === 'AbortError') {
                this.logger.error(
                    `模型请求超时 provider=${this.providerName} model=${this.modelName} durationMs=${durationMs}`,
                );
                throw new BadGatewayException(`模型识别超过 ${Math.round(timeoutMs / 1000)} 秒，已主动终止。`);
            }
            this.logger.error(
                `模型请求失败 provider=${this.providerName} model=${this.modelName} durationMs=${durationMs} error=${error instanceof Error ? error.message : 'unknown'}`,
            );
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    private buildResponsesInput(source: RecipeImportSource, catalogContext: string) {
        const instruction = this.buildInstruction(catalogContext);
        const content: Array<Record<string, unknown>> = [{ type: 'input_text', text: instruction }];
        if (source.text?.trim()) content.push({ type: 'input_text', text: `待识别内容：\n${source.text}` });
        if (source.buffer) {
            const dataUrl = `data:${source.mimeType || 'application/octet-stream'};base64,${source.buffer.toString('base64')}`;
            if (source.mimeType?.startsWith('image/'))
                content.push({ type: 'input_image', image_url: dataUrl, detail: 'high' });
            else content.push({ type: 'input_file', filename: source.fileName || 'recipe-file', file_data: dataUrl });
        }
        return content;
    }

    private buildInstruction(catalogContext: string) {
        return `你是专业烘焙配方结构化助手。你的任务是把用户上传的任意配方文件整理为“中间形态”，供系统后续计算。非常重要：不要计算最终 ratio、flourRatio、烘焙百分比、水分、损耗或产量；系统会用确定性代码计算。你只负责理解结构、保留原始证据、提取原始名称/用量/单位/备注，并标记不确定项。

输出规则：
1. 只输出 JSON 对象，根字段为 intermediateRecipes 和 reviewItems。
2. 每个原料必须保留 rawName 和 rawAmount；rawAmount 保留源文件写法，例如 500、500g、1个、少许。
3. amount 只有在你能明确读出数字时填写数字；unit 填 g、个、份等原始单位。不要把“1个”猜成克重。
4. normalizedName 只在明确匹配系统目录或常见别名时填写；品牌、商品名、模糊名只给建议并加入 reviewItems。
5. MAIN 表示主面团/主配方，PRE_DOUGH 表示面种，EXTRA 表示自制馅料、酱、装饰、夹馅、谷物包等。不要因为 EXTRA 没有面粉而报错。
6. sections 用来表达源文件里的结构，例如 主面团、水解、面种、馅料、装饰、混入。出品规格写入 yieldText 或 products.sourceText。
7. evidence 尽量写清楚来源位置，例如 工作表：贝果 行3 或 图片1 区域上半部。
8. 不确定内容加入 reviewItems，fieldPath 使用 intermediateRecipes.{配方序号} 开始。
9. 不要把有独立标题和原料行的馅料、酱、酥粒、谷物包、波兰种合并进上一个主配方；它们应作为独立 intermediateRecipe 输出，type 通常为 EXTRA 或 PRE_DOUGH。
10. 如果一个主面团下面出现多个带名称的小节（例如 菠菜玉米恰巴塔、香菜牛肉恰巴塔），这些是共享主面团的产品变体；把它们写入 products，并把小节原料写入对应产品的 mixIn/fillings/toppings，不要放进主面团 ingredients。
11. “面：70g/个、馅：55g/个”这类复合出品规格要分别保留 sourceText；不要只保留其中一个数字。

系统现有目录如下，仅在明确匹配时采用规范名称：\n${catalogContext}`;
    }

    private getDeepSeekMaxTokens() {
        const configured = Number(this.config.get<string>('RECIPE_IMPORT_MAX_TOKENS', '65536'));
        if (!Number.isFinite(configured)) return 65536;
        return Math.min(Math.max(Math.trunc(configured), 4096), 65536);
    }

    private deepSeekJsonExample() {
        return {
            intermediateRecipes: [
                {
                    sourceName: '基础吐司',
                    suggestedName: null,
                    type: 'MAIN',
                    category: 'BREAD',
                    notes: '示例配方',
                    yieldText: '100g/个（8个）',
                    sections: [
                        {
                            name: '主面团',
                            kind: 'MAIN_DOUGH',
                            evidence: '示例输入',
                            items: [
                                {
                                    rawName: '高筋面粉',
                                    normalizedName: '高筋小麦粉',
                                    rawAmount: '500g',
                                    amount: 500,
                                    unit: 'g',
                                    isFlour: true,
                                    note: null,
                                    waterContent: null,
                                },
                                {
                                    rawName: '水',
                                    normalizedName: '水',
                                    rawAmount: '300g',
                                    amount: 300,
                                    unit: 'g',
                                    isFlour: false,
                                    note: null,
                                    waterContent: 100,
                                },
                            ],
                        },
                    ],
                    products: [],
                    procedure: [],
                    evidence: '示例输入',
                },
            ],
            reviewItems: [],
        };
    }

    private async extractTextForDeepSeek(source: RecipeImportSource) {
        const pastedText = source.text?.trim();
        if (!source.buffer) {
            if (pastedText) return pastedText;
            throw new BadRequestException('没有可供 DeepSeek 识别的文本内容。');
        }

        const extension = source.fileName?.split('.').pop()?.toLowerCase();
        if (extension === 'txt' || extension === 'csv') {
            const fileText = source.buffer.toString('utf8').trim();
            return [pastedText, fileText].filter(Boolean).join('\n\n');
        }
        if (extension === 'xlsx') {
            const workbook = new ExcelJS.Workbook();
            try {
                await workbook.xlsx.load(source.buffer as unknown as ExcelJS.Buffer);
            } catch {
                throw new BadRequestException('Excel 文件读取失败，请确认文件未损坏且格式为 .xlsx。');
            }
            const sheets: string[] = [];
            workbook.eachSheet((worksheet) => {
                const rows: string[] = [];
                worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
                    const cells: string[] = [];
                    for (let columnNumber = 1; columnNumber <= row.cellCount; columnNumber++) {
                        cells.push(this.getExcelCellText(row.getCell(columnNumber)));
                    }
                    while (cells.length && !cells[cells.length - 1]) cells.pop();
                    if (cells.some(Boolean)) rows.push(`${rowNumber}\t${cells.join('\t')}`);
                });
                if (rows.length) sheets.push(`工作表：${worksheet.name}\n${rows.join('\n')}`);
            });
            const excelText = sheets.join('\n\n').slice(0, 120000);
            if (!excelText) throw new BadRequestException('Excel 文件中没有可识别的单元格内容。');
            return [pastedText, excelText].filter(Boolean).join('\n\n');
        }
        if (extension === 'xls') {
            throw new BadRequestException('DeepSeek 导入暂不支持旧版 .xls，请另存为 .xlsx 后重试。');
        }
        if (source.mimeType?.startsWith('image/') || extension === 'pdf') {
            throw new BadRequestException(
                'DeepSeek V4 Flash 官方 API 不支持图片或 PDF 视觉输入。请配置支持视觉的模型，或先将内容转为 Excel/CSV/文本。',
            );
        }
        throw new BadRequestException('DeepSeek 当前只能处理文本、CSV 和 .xlsx 配方文件。');
    }

    private getExcelCellText(cell: ExcelJS.Cell) {
        if (cell.type === ExcelJS.ValueType.Merge) return '';
        try {
            return cell.text?.trim() || '';
        } catch {
            const value = cell.value;
            if (value == null) return '';
            if (value instanceof Date) return value.toISOString();
            if (typeof value === 'object') {
                if ('result' in value && value.result != null) return String(value.result).trim();
                if ('text' in value && value.text != null) return String(value.text).trim();
                if ('richText' in value && Array.isArray(value.richText))
                    return value.richText
                        .map((part) => part.text || '')
                        .join('')
                        .trim();
                return '';
            }
            return String(value).trim();
        }
    }

    private withDiagnostics(error: unknown, extractedText: string, rawModelOutput: string) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        return Object.assign(normalizedError, { diagnostics: { extractedText, rawModelOutput } });
    }

    private parseModelResult(outputText?: string) {
        if (!outputText) throw new BadGatewayException('智能识别服务没有返回可解析的配方。');
        const normalized = outputText
            .trim()
            .replace(/^\uFEFF/, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
        const objectStart = normalized.indexOf('{');
        const objectEnd = normalized.lastIndexOf('}');
        const candidates = [
            normalized,
            objectStart >= 0 && objectEnd > objectStart ? normalized.slice(objectStart, objectEnd + 1) : '',
        ].filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);

        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate) as ModelImportResult;
                const hasLegacyRecipes = Array.isArray(parsed.recipes);
                const hasIntermediateRecipes = Array.isArray(parsed.intermediateRecipes);
                if ((hasLegacyRecipes || hasIntermediateRecipes) && Array.isArray(parsed.reviewItems)) return parsed;
            } catch {
                // Try the next safely extracted candidate before reporting the raw model output.
            }
        }

        const logFullOutput =
            this.config.get<string>('RECIPE_IMPORT_LOG_MODEL_OUTPUT', 'false').toLowerCase() === 'true';
        const limit = logFullOutput ? 20000 : 1500;
        const preview = outputText.slice(0, limit);
        this.logger.error(
            `模型返回无法解析为配方 JSON provider=${this.providerName} model=${this.modelName} length=${outputText.length} output=${JSON.stringify(preview)}${outputText.length > limit ? '…[truncated]' : ''}`,
        );
        throw new BadGatewayException(
            logFullOutput
                ? '智能识别结果不是有效的结构化数据，原始返回已记录到后台日志。'
                : '智能识别结果不是有效的结构化数据，后台已记录返回预览。',
        );
    }

    private createDevelopmentResult(source: RecipeImportSource): ModelImportResult {
        const text = source.text?.trim() || '';
        if (text.startsWith('{') || text.startsWith('[')) {
            try {
                const parsed = JSON.parse(text) as ModelImportResult | NonNullable<ModelImportResult['recipes']>;
                return Array.isArray(parsed) ? { recipes: parsed } : parsed;
            } catch {
                throw new BadRequestException('粘贴的测试 JSON 格式不正确。');
            }
        }
        throw new BadRequestException('开发环境未配置模型 API Key。可粘贴标准 JSON 进行流程测试。');
    }

    private outputSchema() {
        const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
        const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
        const ingredient = {
            type: 'object',
            additionalProperties: false,
            required: [
                'rawName',
                'normalizedName',
                'rawAmount',
                'amount',
                'unit',
                'note',
                'isFlour',
                'waterContent',
                'evidence',
            ],
            properties: {
                rawName: { type: 'string' },
                normalizedName: nullableString,
                rawAmount: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
                amount: nullableNumber,
                unit: nullableString,
                note: nullableString,
                isFlour: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
                waterContent: nullableNumber,
                evidence: nullableString,
            },
        };
        const section = {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'kind', 'items', 'evidence'],
            properties: {
                name: nullableString,
                kind: {
                    anyOf: [
                        {
                            type: 'string',
                            enum: ['MAIN_DOUGH', 'PRE_DOUGH', 'EXTRA', 'FILLING', 'TOPPING', 'MIX_IN', 'NOTE'],
                        },
                        { type: 'null' },
                    ],
                },
                items: { type: 'array', items: ingredient },
                evidence: nullableString,
            },
        };
        const productIngredient = {
            type: 'object',
            additionalProperties: false,
            required: [
                'rawName',
                'normalizedName',
                'rawAmount',
                'amount',
                'unit',
                'note',
                'isFlour',
                'waterContent',
                'evidence',
            ],
            properties: ingredient.properties,
        };
        const product = {
            type: 'object',
            additionalProperties: false,
            required: [
                'name',
                'sourceText',
                'unitWeight',
                'yieldCount',
                'totalWeight',
                'fillings',
                'mixIn',
                'toppings',
                'procedure',
                'evidence',
            ],
            properties: {
                name: nullableString,
                sourceText: nullableString,
                unitWeight: nullableNumber,
                yieldCount: nullableNumber,
                totalWeight: nullableNumber,
                fillings: { type: 'array', items: productIngredient },
                mixIn: { type: 'array', items: productIngredient },
                toppings: { type: 'array', items: productIngredient },
                procedure: { type: 'array', items: { type: 'string' } },
                evidence: nullableString,
            },
        };
        const review = {
            type: 'object',
            additionalProperties: false,
            required: [
                'recipeName',
                'fieldPath',
                'label',
                'severity',
                'recognizedValue',
                'normalizedValue',
                'reason',
                'derivation',
                'confidence',
            ],
            properties: {
                recipeName: { type: 'string' },
                fieldPath: { type: 'string' },
                label: { type: 'string' },
                severity: { type: 'string', enum: ['INFO', 'REVIEW', 'BLOCKING'] },
                recognizedValue: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
                normalizedValue: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
                reason: { type: 'string' },
                derivation: nullableString,
                confidence: nullableNumber,
            },
        };
        return {
            type: 'object',
            additionalProperties: false,
            required: ['intermediateRecipes', 'reviewItems'],
            properties: {
                intermediateRecipes: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: [
                            'sourceName',
                            'suggestedName',
                            'type',
                            'category',
                            'notes',
                            'yieldText',
                            'sections',
                            'products',
                            'procedure',
                            'evidence',
                        ],
                        properties: {
                            sourceName: { type: 'string' },
                            suggestedName: nullableString,
                            type: { type: 'string', enum: ['MAIN', 'PRE_DOUGH', 'EXTRA'] },
                            category: { type: 'string', enum: ['BREAD', 'PASTRY', 'DESSERT', 'DRINK', 'OTHER'] },
                            notes: nullableString,
                            yieldText: nullableString,
                            sections: { type: 'array', items: section },
                            products: { type: 'array', items: product },
                            procedure: { type: 'array', items: { type: 'string' } },
                            evidence: nullableString,
                        },
                    },
                },
                reviewItems: { type: 'array', items: review },
            },
        };
    }
}
