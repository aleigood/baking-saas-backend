import { PrismaClient, Role, RecipeType, ProductIngredientType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// 定义配方数据的类型，以便在代码中使用
type RecipeSeedData = {
    name: string;
    type: RecipeType;
    targetTemp?: number;
    lossRatio?: number;
    ingredients: {
        name: string;
        ratio: number;
        isFlour?: boolean;
        waterContent?: number;
    }[];
    products?: {
        name: string;
        weight: number;
        fillings?: { name: string; type: ProductIngredientType; weightInGrams: number }[];
        mixIn?: { name: string; type: ProductIngredientType; ratio: number }[];
        procedure?: string[];
    }[];
    procedure?: string[];
};

// [核心修改] 您提供的配方数据, 已将所有 ratio 值从百分比转换为小数
const recipesData: RecipeSeedData[] = [
    {
        name: '恰巴塔',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            { name: '高筋粉', ratio: 0.92, isFlour: true },
            { name: '鲁邦种', ratio: 0.2576 },
            { name: '水', ratio: 0.4, waterContent: 1 },
            { name: '盐', ratio: 0.0084 },
            { name: '糖', ratio: 0.184 },
            { name: '半干酵母', ratio: 0.013 },
            { name: '橄榄油', ratio: 0.08 },
        ],
        products: [
            {
                name: '恰巴塔',
                weight: 250,
                procedure: ['烘烤：一盘6个 上火210 下火180 烤20分钟'],
            },
        ],
        procedure: [
            '搅拌：采用后糖法，搅拌至完全扩展，出缸温度26度',
            '发酵：二发温度35度50分钟',
            '烘烤：烤前刷过筛蛋液，两个杏仁片 一盘10个 上火210 下火180 烤10分钟',
        ],
    },
    {
        name: '云朵吐司面团',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            { name: '高筋粉', ratio: 0.92, isFlour: true },
            { name: '烫种', ratio: 0.2576 },
            { name: '水', ratio: 0.4, waterContent: 1 },
            { name: '盐', ratio: 0.0084 },
            { name: '糖', ratio: 0.184 },
            { name: '半干酵母', ratio: 0.013 },
            { name: '黄油', ratio: 0.08 },
            { name: '奶粉', ratio: 0.02 },
            { name: '全蛋', ratio: 0.2, waterContent: 0.75 },
            { name: '麦芽精', ratio: 0.01 },
        ],
        products: [
            {
                name: '云朵吐司',
                weight: 250,
                procedure: ['烘烤：一盘6个 上火210 下火180 烤20分钟'],
            },
            {
                name: '云朵吐司2',
                weight: 250,
                procedure: ['烘烤：一盘6个 上火210 下火180 烤20分钟'],
            },
            {
                name: '云朵吐司3',
                weight: 250,
                procedure: ['烘烤：一盘6个 上火210 下火180 烤20分钟'],
            },
            {
                name: '云朵吐司4',
                weight: 250,
                procedure: ['烘烤：一盘6个 上火210 下火180 烤20分钟'],
            },
        ],
        procedure: [
            '搅拌：采用后糖法，搅拌至完全扩展，出缸温度26度',
            '发酵：二发温度35度50分钟',
            '烘烤：烤前刷过筛蛋液，两个杏仁片 一盘10个 上火210 下火180 烤10分钟',
        ],
    },
    {
        name: '烫种',
        type: 'PRE_DOUGH',
        lossRatio: 0.1,
        ingredients: [
            { name: '高筋粉', ratio: 1, isFlour: true },
            { name: '水', ratio: 2, waterContent: 1 },
            { name: '糖', ratio: 0.2 },
            { name: '盐', ratio: 0.02 },
        ],
        procedure: ['在室温放置冷却后放入冰箱第二天使用'],
    },
    {
        name: '卡仕达酱',
        type: 'EXTRA',
        lossRatio: 0.05,
        ingredients: [
            { name: '低筋粉', ratio: 0.12, isFlour: true },
            { name: '牛奶', ratio: 1, waterContent: 0.87 },
            { name: '蛋黄', ratio: 0.2 },
            { name: '糖', ratio: 0.2 },
            { name: '黄油', ratio: 0.05 },
        ],
        procedure: ['牛奶温度达到90度后搅拌'],
    },
    {
        name: '甜面团',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            { name: '高筋粉', ratio: 0.92, isFlour: true },
            { name: '烫种', ratio: 0.2576 },
            { name: '水', ratio: 0.4, waterContent: 1 },
            { name: '盐', ratio: 0.0084 },
            { name: '糖', ratio: 0.184 },
            { name: '半干酵母', ratio: 0.013 },
            { name: '黄油', ratio: 0.08 },
            { name: '奶粉', ratio: 0.02 },
            { name: '全蛋', ratio: 0.2, waterContent: 0.75 },
            { name: '麦芽精', ratio: 0.01 },
        ],
        products: [
            {
                name: '熊掌卡仕达',
                weight: 50,
                fillings: [
                    { name: '卡仕达酱', type: 'FILLING', weightInGrams: 30 },
                    { name: '杏仁片', type: 'FILLING', weightInGrams: 1 },
                ],
                mixIn: [{ name: '香草籽', type: 'MIX_IN', ratio: 0.01 }],
                procedure: ['烘烤：烤前刷过筛蛋液，一盘10个 上火210 下火180 烤10分钟'],
            },
            {
                name: '小吐司',
                weight: 250,
                procedure: ['烘烤：一盘6个 上火210 下火180 烤20分钟'],
            },
        ],
        procedure: [
            '搅拌：采用后糖法，搅拌至完全扩展，出缸温度26度',
            '发酵：二发温度35度50分钟',
            '烘烤：烤前刷过筛蛋液，两个杏仁片 一盘10个 上火210 下火180 烤10分钟',
        ],
    },
];

/**
 * 为指定的店铺导入所有配方数据
 * @param tenantId 店铺ID
 * @param recipes 配方数据数组
 */
async function seedRecipesForTenant(tenantId: string, recipes: RecipeSeedData[]) {
    console.log(`为店铺 ID: ${tenantId} 开始导入配方...`);

    // [核心修改] 创建一个Map来存储原料的完整信息，而不仅仅是名字
    const allIngredients = new Map<string, (typeof recipes)[0]['ingredients'][0]>();
    recipes.forEach((recipe) => {
        recipe.ingredients.forEach((ing) => {
            // 只有当原料信息更完整时才更新Map
            const existing = allIngredients.get(ing.name);
            if (!existing || (!existing.isFlour && ing.isFlour)) {
                allIngredients.set(ing.name, ing);
            }
        });
        recipe.products?.forEach((p) => {
            p.fillings?.forEach((f) => {
                if (!allIngredients.has(f.name)) allIngredients.set(f.name, { name: f.name, ratio: 0 });
            });
            p.mixIn?.forEach((m) => {
                if (!allIngredients.has(m.name)) allIngredients.set(m.name, { name: m.name, ratio: 0 });
            });
        });
    });

    for (const [name, details] of allIngredients.entries()) {
        const existingIngredient = await prisma.ingredient.findFirst({
            where: {
                tenantId,
                name,
                deletedAt: null,
            },
        });

        if (!existingIngredient) {
            // [核心修改] 创建原料时，传入isFlour和waterContent
            await prisma.ingredient.create({
                data: {
                    tenantId,
                    name,
                    isFlour: details.isFlour ?? false,
                    waterContent: details.waterContent ?? 0,
                },
            });
        }
    }
    console.log(`为店铺 ID: ${tenantId} 创建了 ${allIngredients.size} 种基础原料。`);

    // 导入配方
    for (const recipeData of recipes) {
        await prisma.$transaction(async (tx) => {
            // 1. 创建配方族
            const recipeFamily = await tx.recipeFamily.create({
                data: {
                    name: recipeData.name,
                    tenantId: tenantId,
                    type: recipeData.type,
                },
            });

            // 2. 创建配方版本
            const recipeVersion = await tx.recipeVersion.create({
                data: {
                    familyId: recipeFamily.id,
                    version: 1,
                    notes: '初始版本',
                    isActive: true,
                },
            });

            // 3. 创建面团和面团原料
            if (recipeData.ingredients) {
                const dough = await tx.dough.create({
                    data: {
                        recipeVersionId: recipeVersion.id,
                        name: recipeData.name,
                        targetTemp: recipeData.targetTemp,
                        lossRatio: recipeData.lossRatio,
                        procedure: recipeData.procedure,
                    },
                });

                for (const ing of recipeData.ingredients) {
                    const linkedIngredient = await tx.ingredient.findFirst({
                        where: { tenantId, name: ing.name, deletedAt: null },
                    });
                    const linkedPreDough = await tx.recipeFamily.findFirst({
                        where: { tenantId, name: ing.name, type: 'PRE_DOUGH', deletedAt: null },
                    });

                    await tx.doughIngredient.create({
                        data: {
                            doughId: dough.id,
                            ratio: ing.ratio,
                            ingredientId: linkedIngredient ? linkedIngredient.id : null,
                            linkedPreDoughId: linkedPreDough ? linkedPreDough.id : null,
                        },
                    });
                }
            }

            // 4. 创建产品和产品原料
            if (recipeData.products) {
                for (const p of recipeData.products) {
                    const product = await tx.product.create({
                        data: {
                            recipeVersionId: recipeVersion.id,
                            name: p.name,
                            baseDoughWeight: p.weight,
                            procedure: p.procedure,
                        },
                    });

                    const productIngredients = [...(p.fillings || []), ...(p.mixIn || [])];

                    for (const pi of productIngredients) {
                        const linkedIngredient = await tx.ingredient.findFirst({
                            where: { tenantId, name: pi.name, deletedAt: null },
                        });
                        const linkedExtra = await tx.recipeFamily.findFirst({
                            where: { tenantId, name: pi.name, type: 'EXTRA', deletedAt: null },
                        });

                        await tx.productIngredient.create({
                            data: {
                                productId: product.id,
                                type: pi.type,
                                ratio: 'ratio' in pi ? pi.ratio : undefined,
                                weightInGrams: 'weightInGrams' in pi ? pi.weightInGrams : undefined,
                                ingredientId: linkedIngredient ? linkedIngredient.id : null,
                                linkedExtraId: linkedExtra ? linkedExtra.id : null,
                            },
                        });
                    }
                }
            }
        });
        console.log(`  - 成功导入配方: ${recipeData.name}`);
    }
}

async function main() {
    console.log('开始执行种子脚本...');

    // 1. 创建超级管理员
    const adminPhone = process.env.SUPER_ADMIN_PHONE || '13955555555';
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin';
    const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.upsert({
        where: { phone: adminPhone },
        update: {},
        create: {
            name: '超级管理员',
            phone: adminPhone,
            password: hashedAdminPassword,
            role: Role.SUPER_ADMIN,
            status: 'ACTIVE',
        },
    });
    console.log(`超级管理员已创建/确认存在: ${adminPhone}`);

    // 2. 创建普通用户 Leo
    const leoPhone = '13966666666';
    const leoPassword = '123';
    const hashedLeoPassword = await bcrypt.hash(leoPassword, 10);

    const leo = await prisma.user.upsert({
        where: { phone: leoPhone },
        update: {},
        create: {
            name: 'Leo',
            phone: leoPhone,
            password: hashedLeoPassword,
            role: Role.OWNER,
            status: 'ACTIVE',
        },
    });
    console.log(`用户 "Leo" 已创建/确认存在: ${leoPhone}`);

    // 3. 为 Leo 创建两个店铺
    const tenant1 = await prisma.tenant.create({
        data: {
            name: '小时光',
            members: {
                create: {
                    userId: leo.id,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            },
        },
    });
    console.log(`店铺 "小时光" 已创建`);

    const tenant2 = await prisma.tenant.create({
        data: {
            name: '大时光',
            members: {
                create: {
                    userId: leo.id,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            },
        },
    });
    console.log(`店铺 "大时光" 已创建`);

    // 4. 为这两个店铺导入配方数据
    await seedRecipesForTenant(tenant1.id, recipesData);
    await seedRecipesForTenant(tenant2.id, recipesData);

    console.log('种子脚本执行完毕！');
}

main()
    .catch((e) => {
        console.error('种子脚本执行失败:', e);
        process.exit(1);
    })
    .finally(() => {
        void prisma.$disconnect();
    });
