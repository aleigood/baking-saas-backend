import { BadRequestException } from '@nestjs/common';

import { RecipeImportService } from './recipe-import.service';

describe('RecipeImportService', () => {
    const editorService = {
        getEditorMe: jest.fn().mockResolvedValue({ tenant: { id: 'tenant-1' } }),

        listIngredients: jest.fn().mockResolvedValue({
            ingredients: [
                { id: 'ingredient-1', name: '高筋小麦粉' },

                { id: 'ingredient-2', name: '水' },

                { id: 'ingredient-3', name: '半干酵母' },
            ],
        }),

        listRecipes: jest.fn().mockResolvedValue({ recipes: [] }),
    };

    const modelProvider = {
        providerName: 'test',

        modelName: 'test-model',

        analyze: jest.fn(),
    };

    const recipeImportJob = {
        create: jest.fn(),

        findFirst: jest.fn(),

        findMany: jest.fn(),

        findUnique: jest.fn(),

        update: jest.fn(),

        updateMany: jest.fn(),
    };

    const service = new RecipeImportService(
        editorService as never,

        modelProvider as never,

        { recipeImportJob } as never,
    );

    beforeEach(() => {
        jest.clearAllMocks();

        delete process.env.RECIPE_IMPORT_REUSE_LAST_SUCCESS;

        delete process.env.RECIPE_IMPORT_REUSE_LAST_SUCCESS_TTL_MS;
    });

    it('rejects an empty import request', async () => {
        await expect(service.analyze('session', 'token', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unsupported file types before invoking the model', async () => {
        await expect(
            service.analyze('session', 'token', {
                fileName: 'recipe.exe',

                buffer: Buffer.from('not-a-recipe'),
            }),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(modelProvider.analyze).not.toHaveBeenCalled();
    });

    it('creates a persistent asynchronous import job and returns immediately', async () => {
        const immediate = jest.spyOn(global, 'setImmediate').mockImplementation(() => 0 as never);

        recipeImportJob.findMany.mockResolvedValue([]);

        recipeImportJob.create.mockResolvedValue({
            id: 'job-1',

            status: 'PENDING',

            createdAt: new Date('2026-07-08T00:00:00.000Z'),
        });

        const result = await service.createJob('session', 'token', { text: '测试配方' });

        expect(result).toMatchObject({ jobId: 'job-1', status: 'PENDING' });

        expect(recipeImportJob.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ tenantId: 'tenant-1', sourceText: '测试配方' }),
            }),
        );

        expect(immediate).toHaveBeenCalled();

        immediate.mockRestore();
    });

    it('reuses the latest successful import job in explicit debug mode', async () => {
        process.env.RECIPE_IMPORT_REUSE_LAST_SUCCESS = 'true';

        recipeImportJob.findMany.mockResolvedValue([
            {
                id: 'job-reused',

                status: 'COMPLETED',

                createdAt: new Date('2026-07-08T00:00:00.000Z'),

                sourceData: null,

                sourceText: '测试配方',

                result: { meta: { provider: 'test', model: 'test-model' } },
            },
        ]);

        const result = await service.createJob('session', 'token', { text: '测试配方' });

        expect(result).toMatchObject({ jobId: 'job-reused', status: 'COMPLETED', reused: true });

        expect(recipeImportJob.create).not.toHaveBeenCalled();

        expect(modelProvider.analyze).not.toHaveBeenCalled();
    });

    it('processes a claimed job and retains diagnostics for support', async () => {
        recipeImportJob.updateMany.mockResolvedValue({ count: 1 });

        recipeImportJob.findUnique.mockResolvedValue({
            id: 'job-1',

            fileName: null,

            mimeType: null,

            sourceData: null,

            sourceText: '测试内容',

            catalogContext: '原料：高筋小麦粉、水',
        });

        recipeImportJob.update.mockResolvedValue({});

        modelProvider.analyze.mockResolvedValue({
            recipes: [
                {
                    name: '异步测试吐司',

                    type: 'MAIN',

                    category: 'BREAD',

                    versions: [{ notes: '导入', ingredients: [{ name: '高筋小麦粉', ratio: 1 }] }],
                },
            ],

            reviewItems: [],

            diagnostics: { extractedText: '测试内容', rawModelOutput: '{"recipes":[]}' },
        });

        await (service as unknown as { processJob(id: string): Promise<void> }).processJob('job-1');

        expect(recipeImportJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'job-1' },

                data: expect.objectContaining({
                    status: 'COMPLETED',

                    diagnosticData: expect.objectContaining({ extractedText: '测试内容' }),

                    diagnosticExpiresAt: expect.any(Date),
                }),
            }),
        );
    });

    it('normalizes recipes and adds a blocking item when an ingredient has no usable amount', async () => {
        modelProvider.analyze.mockResolvedValue({
            recipes: [
                {
                    name: '测试吐司',

                    type: 'MAIN',

                    category: 'BREAD',

                    versions: [{ notes: '', lossRatio: 1, ingredients: [{ name: '水' }] }],
                },
            ],

            reviewItems: [],
        });

        const result = await service.analyze('session', 'token', { text: '测试内容' });

        expect(result.recipes[0].versions[0].notes).toBe('智能导入');

        expect(result.recipes[0].versions[0].lossRatio).toBe(0.01);

        expect(result.summary.blockingCount).toBe(1);

        expect(result.ingredients).toEqual([
            expect.objectContaining({ sourceName: '水', normalizedName: '水', status: 'MATCHED' }),
        ]);

        expect(result.reviewItems[0]).toMatchObject({
            recipeName: '测试吐司',

            severity: 'BLOCKING',

            status: 'PENDING',
        });
    });

    it('uses the recipe name when a main recipe contains only one product', async () => {
        modelProvider.analyze.mockResolvedValue({
            recipes: [
                {
                    name: '盐可颂',

                    type: 'MAIN',

                    category: 'BREAD',

                    versions: [
                        {
                            notes: '导入',

                            ingredients: [{ name: '高筋小麦粉', ratio: 1 }],

                            products: [{ name: '产品1', weight: 80 }],
                        },
                    ],
                },
            ],

            reviewItems: [],
        });

        const result = await service.analyze('session', 'token', { text: '盐可颂' });

        expect(result.recipes[0].versions[0].products?.[0].name).toBe('盐可颂');
    });

    it('keeps model review evidence in the analysis response', async () => {
        modelProvider.analyze.mockResolvedValue({
            recipes: [
                {
                    name: '测试吐司',

                    type: 'MAIN',

                    category: 'BREAD',

                    versions: [{ notes: '导入', ingredients: [{ name: '高筋小麦粉', ratio: 100 }] }],
                },
            ],

            reviewItems: [
                {
                    recipeName: '测试吐司',

                    fieldPath: 'recipes.0.versions.0.ingredients.0.name',

                    label: '原料名称',

                    severity: 'REVIEW',

                    recognizedValue: '高粉',

                    normalizedValue: '高筋小麦粉',

                    reason: '使用了原料别名',

                    confidence: 0.86,
                },
            ],
        });

        const result = await service.analyze('session', 'token', { text: '高粉 100' });

        expect(result.summary.reviewCount).toBe(0);

        expect(result.reviewItems).toHaveLength(0);

        expect(result.ingredients).toEqual([
            expect.objectContaining({
                sourceName: '高粉',

                normalizedName: '高筋小麦粉',

                status: 'REVIEW',
            }),
        ]);
    });

    it('converts intermediate model output with system-owned ratio calculation', async () => {
        modelProvider.analyze.mockResolvedValue({
            intermediateRecipes: [
                {
                    sourceName: '原味贝果',

                    suggestedName: null,

                    type: 'MAIN',

                    category: 'BREAD',

                    notes: '来自贝果工作表',

                    yieldText: '110g/个（11个）',

                    sections: [
                        {
                            name: '主面团',

                            kind: 'MAIN_DOUGH',

                            evidence: '工作表：贝果 行3-10',

                            items: [
                                {
                                    rawName: '高粉',

                                    normalizedName: '高筋小麦粉',

                                    rawAmount: '500',

                                    amount: 500,

                                    unit: 'g',

                                    note: null,

                                    isFlour: true,

                                    waterContent: null,

                                    evidence: '行3',
                                },

                                {
                                    rawName: '水',

                                    normalizedName: '水',

                                    rawAmount: '300',

                                    amount: 300,

                                    unit: 'g',

                                    note: null,

                                    isFlour: false,

                                    waterContent: 100,

                                    evidence: '行4',
                                },

                                {
                                    rawName: '柠檬皮屑',

                                    normalizedName: '柠檬皮屑',

                                    rawAmount: '1个',

                                    amount: 1,

                                    unit: '个',

                                    note: null,

                                    isFlour: false,

                                    waterContent: null,

                                    evidence: '行5',
                                },
                            ],
                        },
                    ],

                    products: [],

                    procedure: [],

                    evidence: '工作表：贝果',
                },
            ],

            reviewItems: [
                {
                    recipeName: '原味贝果',

                    fieldPath: 'intermediateRecipes.0.sections.0.items.2.amount',

                    label: '柠檬皮屑用量',

                    severity: 'REVIEW',

                    recognizedValue: '1个',

                    normalizedValue: null,

                    reason: '数量单位无法直接换算为克重',
                },
            ],

            diagnostics: { extractedText: '原味贝果', rawModelOutput: '{"intermediateRecipes":[]}' },
        });

        const result = await service.analyze('session', 'token', { text: '原味贝果' });

        const version = result.recipes[0].versions[0];

        expect(version.ingredients).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: '高筋小麦粉', ratio: 1, isFlour: true }),

                expect.objectContaining({ name: '水', ratio: 0.6, waterContent: 100 }),

                expect.objectContaining({ name: '柠檬皮屑', ratio: undefined }),
            ]),
        );

        expect(version.products?.[0]).toMatchObject({ name: '原味贝果', weight: 110 });

        expect(result.summary.blockingCount).toBe(0);

        expect(result.reviewItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ label: '柠檬皮屑用量', severity: 'REVIEW', recognizedValue: '1个' }),
            ]),
        );

        expect(result.reviewItems).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    label: '原料名称',

                    recognizedValue: '高粉',

                    normalizedValue: '高筋小麦粉',
                }),
            ]),
        );

        const amountTasks = result.reviewItems.filter((item) => item.label === '柠檬皮屑用量');

        expect(amountTasks).toHaveLength(1);

        expect(amountTasks[0]).toMatchObject({
            fieldId: 'recipe-import-field:原味贝果::amount::柠檬皮屑用量',

            status: 'PENDING',
        });

        expect(amountTasks[0].diagnostics).toHaveLength(2);

        expect(result.diagnostics?.intermediateResult?.intermediateRecipes[0].sourceName).toBe('原味贝果');
    });

    it('keeps fillings as extra recipes and mix-in sections as product variants', async () => {
        modelProvider.analyze.mockResolvedValue({
            intermediateRecipes: [
                {
                    sourceName: '恰巴塔',

                    suggestedName: null,

                    type: 'MAIN',

                    category: 'BREAD',

                    notes: null,

                    yieldText: '约220g/个 均分12个',

                    sections: [
                        {
                            name: '主面团',

                            kind: 'MAIN_DOUGH',

                            evidence: '行1-4',

                            items: [
                                {
                                    rawName: '高粉',
                                    normalizedName: '高筋小麦粉',
                                    rawAmount: '1000',
                                    amount: 1000,
                                    unit: 'g',
                                    note: null,
                                    isFlour: true,
                                    waterContent: null,
                                    evidence: '行1',
                                },

                                {
                                    rawName: '水',
                                    normalizedName: '水',
                                    rawAmount: '650',
                                    amount: 650,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: 100,
                                    evidence: '行2',
                                },
                            ],
                        },

                        {
                            name: '菠菜玉米恰巴塔',

                            kind: 'MIX_IN',

                            evidence: '行5-6',

                            items: [
                                {
                                    rawName: '菠菜',
                                    normalizedName: '菠菜',
                                    rawAmount: '200',
                                    amount: 200,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: null,
                                    evidence: '行5',
                                },
                            ],
                        },
                    ],

                    products: [],

                    procedure: [],

                    evidence: '工作表：欧包',
                },

                {
                    sourceName: '树莓布里欧修',

                    suggestedName: null,

                    type: 'MAIN',

                    category: 'BREAD',

                    notes: null,

                    yieldText: '80g/个（27个）',

                    sections: [
                        {
                            name: '主面团',

                            kind: 'MAIN_DOUGH',

                            evidence: '行1-2',

                            items: [
                                {
                                    rawName: '高粉',
                                    normalizedName: '高筋小麦粉',
                                    rawAmount: '1000',
                                    amount: 1000,
                                    unit: 'g',
                                    note: null,
                                    isFlour: true,
                                    waterContent: null,
                                    evidence: '行1',
                                },
                            ],
                        },

                        {
                            name: '树莓奶酪馅',

                            kind: 'FILLING',

                            evidence: '行3-4',

                            items: [
                                {
                                    rawName: '冷冻树莓',
                                    normalizedName: '冷冻树莓',
                                    rawAmount: '1000',
                                    amount: 1000,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: null,
                                    evidence: '行3',
                                },

                                {
                                    rawName: '糖',
                                    normalizedName: '糖',
                                    rawAmount: '120',
                                    amount: 120,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: null,
                                    evidence: '行4',
                                },
                            ],
                        },
                    ],

                    products: [],

                    procedure: [],

                    evidence: '工作表：布里欧修',
                },
            ],

            reviewItems: [],
        });

        const result = await service.analyze('session', 'token', { text: '测试配方' });

        const ciabatta = result.recipes.find((recipe) => recipe.name === '恰巴塔');

        const filling = result.recipes.find((recipe) => recipe.name === '树莓奶酪馅');

        const brioche = result.recipes.find((recipe) => recipe.name === '树莓布里欧修');

        expect(ciabatta?.versions[0].ingredients.map((ingredient) => ingredient.name)).toEqual(['高筋小麦粉', '水']);

        expect(ciabatta?.versions[0].products?.[0]).toMatchObject({
            name: '菠菜玉米恰巴塔',

            weight: 220,

            mixIn: [expect.objectContaining({ name: '菠菜', weightInGrams: 200 })],
        });

        expect(brioche?.versions[0].ingredients.map((ingredient) => ingredient.name)).toEqual(['高筋小麦粉']);

        expect(filling).toMatchObject({ name: '树莓奶酪馅', type: 'EXTRA', category: 'OTHER' });

        expect(result.reviewItems).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    recipeName: '树莓布里欧修',

                    label: '冷冻树莓数量未转换为g',
                }),
            ]),
        );
    });

    it('merges deterministic ingredient aliases and skips redundant review prompts', async () => {
        modelProvider.analyze.mockResolvedValue({
            intermediateRecipes: [
                {
                    sourceName: '原味法棍',

                    suggestedName: null,

                    type: 'MAIN',

                    category: 'BREAD',

                    notes: null,

                    yieldText: null,

                    sections: [
                        {
                            name: '主面团',

                            kind: 'MAIN_DOUGH',

                            evidence: '行1-6',

                            items: [
                                {
                                    rawName: '高粉',
                                    normalizedName: '高筋小麦粉',
                                    rawAmount: '1000',
                                    amount: 1000,
                                    unit: 'g',
                                    note: null,
                                    isFlour: true,
                                    waterContent: null,
                                    evidence: '行1',
                                },

                                {
                                    rawName: '水',
                                    normalizedName: '水',
                                    rawAmount: '650',
                                    amount: 650,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: 100,
                                    evidence: '行2',
                                },

                                {
                                    rawName: '后加水',
                                    normalizedName: '水',
                                    rawAmount: '100',
                                    amount: 100,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: 100,
                                    evidence: '行3',
                                },

                                {
                                    rawName: '低糖干酵母',
                                    normalizedName: '半干酵母',
                                    rawAmount: '3',
                                    amount: 3,
                                    unit: 'g',
                                    note: null,
                                    isFlour: false,
                                    waterContent: null,
                                    evidence: '行4',
                                },
                            ],
                        },
                    ],

                    products: [],

                    procedure: [],

                    evidence: '工作表：法棍',
                },
            ],

            reviewItems: [
                {
                    recipeName: '原味法棍',

                    fieldPath: 'recipes.0.versions.0.ingredients.2.name',

                    label: '原料名称',

                    severity: 'REVIEW',

                    recognizedValue: '后加水',

                    normalizedValue: '水',

                    reason: '模型建议确认',
                },
            ],
        });

        const result = await service.analyze('session', 'token', { text: '原味法棍' });

        const ingredients = result.recipes[0].versions[0].ingredients;

        expect(ingredients.filter((ingredient) => ingredient.name === '水')).toHaveLength(1);

        expect(ingredients).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: '水', ratio: 0.75 }),

                expect.objectContaining({ name: '半干酵母', ratio: 0.003 }),
            ]),
        );

        expect(result.reviewItems).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ recognizedValue: '后加水', normalizedValue: '水' }),

                expect.objectContaining({ recognizedValue: '低糖干酵母', normalizedValue: '半干酵母' }),
            ]),
        );

        expect(result.ingredients).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ sourceName: '水', normalizedName: '水', status: 'MATCHED' }),

                expect.objectContaining({ sourceName: '半干酵母', normalizedName: '半干酵母', status: 'MATCHED' }),
            ]),
        );
    });
});
