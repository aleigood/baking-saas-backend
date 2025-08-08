import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
// [FIX] 导入所有需要的 Prisma 模型类型
import {
    Dough,
    DoughIngredient,
    Ingredient,
    IngredientSKU,
    Product,
    ProductIngredient,
    RecipeFamily,
    RecipeVersion,
} from '@prisma/client';

type IngredientWithActiveSku = Ingredient & {
    activeSku: IngredientSKU | null;
};

interface ConsumptionDetail {
    ingredientId: string;
    ingredientName: string;
    activeSkuId: string | null;
    totalConsumed: number; // in grams
}

// [新增] 定义一个更详细的类型，用于在递归计算中传递配方数据
type FullRecipeVersion = RecipeVersion & {
    doughs: (Dough & {
        ingredients: (DoughIngredient & {
            linkedPreDough:
                | (RecipeFamily & {
                      versions: (RecipeVersion & {
                          doughs: (Dough & {
                              ingredients: DoughIngredient[];
                          })[];
                      })[];
                  })
                | null;
        })[];
    })[];
};

// [FIX] 为 FullProduct 类型添加 ingredients 属性
type FullProduct = Product & {
    recipeVersion: FullRecipeVersion & { family: RecipeFamily }; // [修正] 确保 family 被包含
    ingredients: ProductIngredient[];
};

// [新增] 为 processDough 函数的参数定义更精确的类型
type ProcessableIngredient = DoughIngredient & {
    linkedPreDough?: {
        versions: {
            doughs: (Dough & {
                ingredients: DoughIngredient[];
            })[];
        }[];
    } | null;
};

type ProcessableDough = Dough & {
    ingredients: ProcessableIngredient[];
};

@Injectable()
export class CostingService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * [核心逻辑最终修正] 获取产品成本的历史变化记录
     * @param tenantId 租户ID
     * @param productId 产品ID
     * @returns 一个包含每次成本变化点的数组
     */
    async getProductCostHistory(tenantId: string, productId: string) {
        // 1. 获取产品的完整配方信息
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        // 2. 将配方扁平化，计算出每种基础原料的总用量
        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientNames = Array.from(flatIngredients.keys());
        if (ingredientNames.length === 0) return [];

        // 3. 找到这些原料及其所有SKU
        const ingredientsWithSkus = await this.prisma.ingredient.findMany({
            where: { tenantId, name: { in: ingredientNames }, deletedAt: null },
            select: { id: true, name: true, skus: { select: { id: true } } },
        });

        const costHistory: { cost: number }[] = [];
        const today = new Date();

        // 4. 循环10次，为最近10周每周生成一个成本快照
        for (let i = 0; i < 10; i++) {
            const weekEndDate = new Date(today);
            weekEndDate.setDate(today.getDate() - i * 7);

            let weeklyTotalCost = new Decimal(0);

            // 5. 对配方中的每种原料，查找在当周结束前的最新采购价格
            for (const [name, weight] of flatIngredients.entries()) {
                const ingredientInfo = ingredientsWithSkus.find((ing) => ing.name === name);
                if (!ingredientInfo || ingredientInfo.skus.length === 0) {
                    continue; // 如果原料没有SKU，则跳过
                }

                const skuIds = ingredientInfo.skus.map((s) => s.id);

                const latestProcurement = await this.prisma.procurementRecord.findFirst({
                    where: {
                        skuId: { in: skuIds },
                        purchaseDate: { lte: weekEndDate },
                    },
                    orderBy: {
                        purchaseDate: 'desc',
                    },
                    include: {
                        sku: { select: { specWeightInGrams: true } },
                    },
                });

                // 如果找到了采购记录，则用该价格计算成本
                if (latestProcurement) {
                    const pricePerGram = new Decimal(latestProcurement.pricePerPackage).div(
                        latestProcurement.sku.specWeightInGrams,
                    );
                    weeklyTotalCost = weeklyTotalCost.add(pricePerGram.mul(weight));
                }
            }
            costHistory.push({ cost: weeklyTotalCost.toDP(4).toNumber() });
        }

        // 6. 反转数组，使图表从左到右时间递增
        return costHistory.reverse();
    }

    /**
     * [修改] 获取单个原料成本的历史变化记录, 限定为最近10次采购
     * @param tenantId 租户ID
     * @param ingredientId 原料ID
     * @returns 一个包含每次成本变化点的数组 (单位: 元/kg)
     */
    async getIngredientCostHistory(tenantId: string, ingredientId: string) {
        // 1. 查找原料，确保它属于该租户
        const ingredient = await this.prisma.ingredient.findFirst({
            where: { id: ingredientId, tenantId },
            include: { skus: true }, // 包含其下所有的SKU
        });

        if (!ingredient) {
            throw new NotFoundException('原料不存在');
        }

        const skuIds = ingredient.skus.map((sku) => sku.id);
        if (skuIds.length === 0) {
            return []; // 如果没有任何SKU，则没有价格历史
        }

        // 2. [修改] 获取该原料所有SKU的最近10条采购记录
        const procurementRecords = await this.prisma.procurementRecord.findMany({
            where: { skuId: { in: skuIds } },
            include: { sku: true }, // 包含SKU信息以获取规格重量
            orderBy: { purchaseDate: 'desc' }, // 按日期降序排序以获取最新的记录
            take: 10, // 限制为10条
        });

        if (procurementRecords.length === 0) {
            return []; // 如果没有采购记录，则没有价格历史
        }

        // 3. 将采购记录映射为成本历史点 (成本单位: 元/kg)
        const costHistory = procurementRecords.map((record) => {
            const pricePerPackage = new Decimal(record.pricePerPackage);
            const specWeightInGrams = new Decimal(record.sku.specWeightInGrams);

            // 防止除以零的错误
            if (specWeightInGrams.isZero()) {
                return { cost: 0 };
            }

            // 计算每公斤的价格
            const costPerKg = pricePerPackage.div(specWeightInGrams).mul(1000);

            return {
                cost: costPerKg.toDP(2).toNumber(), // 返回每公斤成本，保留两位小数
            };
        });

        // 4. [新增] 因为查询时是倒序的，所以需要反转数组以保证图表时间轴正确
        return costHistory.reverse();
    }

    /**
     * [新增] 获取单个原料最近10次制作的用量历史
     * @param tenantId 租户ID
     * @param ingredientId 原料ID
     * @returns 一个包含每次用量（克）的数组
     */
    async getIngredientUsageHistory(tenantId: string, ingredientId: string) {
        // 1. 验证原料是否存在于该租户
        const ingredientExists = await this.prisma.ingredient.findFirst({
            where: { id: ingredientId, tenantId },
        });
        if (!ingredientExists) {
            throw new NotFoundException('原料不存在');
        }

        // 2. 查询最近10条消耗记录
        const consumptionLogs = await this.prisma.ingredientConsumptionLog.findMany({
            where: {
                ingredientId: ingredientId,
            },
            orderBy: {
                productionLog: {
                    completedAt: 'desc',
                },
            },
            take: 10,
            select: {
                quantityInGrams: true,
            },
        });

        // 3. 格式化并反转数组以匹配图表顺序
        return consumptionLogs.map((log) => ({ cost: log.quantityInGrams })).reverse();
    }

    /**
     * [核心重构] 计算单个产品的当前成本，现在调用新的辅助函数
     */
    async calculateProductCost(tenantId: string, productId: string) {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientsMap = await this.getIngredientsWithActiveSku(tenantId);
        let totalCost = new Decimal(0);

        for (const [name, weight] of flatIngredients.entries()) {
            const ingredientInfo = ingredientsMap.get(name);
            // [编译错误修复] 从 ingredientInfo (原料) 获取价格，从 activeSku 获取规格重量
            if (ingredientInfo?.activeSku) {
                const pricePerGram = new Decimal(ingredientInfo.currentPricePerPackage).div(
                    ingredientInfo.activeSku.specWeightInGrams,
                );
                const cost = pricePerGram.mul(weight);
                totalCost = totalCost.add(cost);
            }
        }

        return {
            productId: product.id,
            productName: product.name,
            totalCost: totalCost.toFixed(4),
        };
    }

    /**
     * [核心新增] 计算产品中各原料的成本构成
     * @param tenantId 租户ID
     * @param productId 产品ID
     * @returns 返回一个包含 { name: string, value: number } 的数组，用于饼图
     */
    async calculateIngredientCostBreakdown(
        tenantId: string,
        productId: string,
    ): Promise<{ name: string; value: number }[]> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientsMap = await this.getIngredientsWithActiveSku(tenantId);
        const costBreakdown: { name: string; value: number }[] = [];

        for (const [name, weight] of flatIngredients.entries()) {
            const ingredientInfo = ingredientsMap.get(name);
            if (ingredientInfo?.activeSku) {
                const pricePerGram = new Decimal(ingredientInfo.currentPricePerPackage).div(
                    ingredientInfo.activeSku.specWeightInGrams,
                );
                const cost = pricePerGram.mul(weight);
                costBreakdown.push({
                    name: name,
                    value: cost.toDP(4).toNumber(),
                });
            }
        }

        return costBreakdown;
    }

    /**
     * [核心新增] 私有辅助方法：获取一个产品的完整配方信息，包括所有嵌套的面种
     */
    private async getFullProduct(tenantId: string, productId: string): Promise<FullProduct | null> {
        return this.prisma.product.findFirst({
            where: { id: productId, recipeVersion: { family: { tenantId }, isActive: true } },
            include: {
                recipeVersion: {
                    include: {
                        family: true,
                        doughs: {
                            include: {
                                ingredients: {
                                    include: {
                                        linkedPreDough: {
                                            include: {
                                                versions: {
                                                    where: { isActive: true },
                                                    include: {
                                                        doughs: {
                                                            include: {
                                                                ingredients: true,
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                // [新增] 包含产品本身的附加原料
                ingredients: true,
            },
        }) as Promise<FullProduct | null>;
    }

    /**
     * [核心新增] 私有辅助方法：将一个完整的配方（含面种）扁平化，计算出每种基础原料的总克重
     */
    private async _getFlattenedIngredients(product: FullProduct): Promise<Map<string, number>> {
        const flattenedIngredients = new Map<string, number>(); // Map<ingredientName, weightInGrams>

        // [核心修正] 1. 收集所有需要查询的原料名称
        const allIngredientNames = new Set<string>();
        const collectIngredientNames = (dough: ProcessableDough) => {
            dough.ingredients.forEach((ing) => {
                const preDough = ing.linkedPreDough?.versions?.[0];
                if (preDough && preDough.doughs[0]) {
                    collectIngredientNames(preDough.doughs[0]);
                } else {
                    allIngredientNames.add(ing.name);
                }
            });
        };
        product.recipeVersion.doughs.forEach((dough) => collectIngredientNames(dough));
        product.ingredients?.forEach((pIng) => allIngredientNames.add(pIng.name));

        // [核心修正] 2. 一次性从数据库查询所有原料的 isFlour 属性
        const ingredientsFromDb = await this.prisma.ingredient.findMany({
            where: {
                tenantId: product.recipeVersion.family.tenantId,
                name: { in: Array.from(allIngredientNames) },
            },
            select: { name: true, isFlour: true },
        });
        const ingredientInfoMap = new Map(ingredientsFromDb.map((i) => [i.name, i]));

        // [修复] 移除未使用的 isMainDough 参数，并为 dough 参数添加精确类型
        const processDough = (dough: ProcessableDough, doughWeight: number) => {
            let totalFlourRatio = 0;
            dough.ingredients.forEach((ing) => {
                // [核心修正] 3. 从查询结果中获取 isFlour 属性
                const ingredientInfo = ingredientInfoMap.get(ing.name);
                if (ingredientInfo?.isFlour) {
                    totalFlourRatio += ing.ratio;
                }
            });
            if (totalFlourRatio === 0) totalFlourRatio = 100;

            const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
            const flourWeightInDough = (doughWeight * totalFlourRatio) / totalRatio;

            for (const ing of dough.ingredients) {
                const ingredientWeight = (flourWeightInDough * ing.ratio) / 100;
                const preDough = ing.linkedPreDough?.versions?.[0];

                if (preDough) {
                    processDough(preDough.doughs[0], ingredientWeight);
                } else {
                    const currentWeight = flattenedIngredients.get(ing.name) || 0;
                    flattenedIngredients.set(ing.name, currentWeight + ingredientWeight);
                }
            }
        };

        // 处理主配方中的面团
        product.recipeVersion.doughs.forEach((dough) => {
            processDough(dough, product.baseDoughWeight);
        });

        // [新增] 处理产品本身的附加原料（如馅料、装饰等）
        product.ingredients?.forEach((pIng) => {
            if (pIng.weightInGrams) {
                const currentWeight = flattenedIngredients.get(pIng.name) || 0;
                flattenedIngredients.set(pIng.name, currentWeight + pIng.weightInGrams);
            }
        });

        return flattenedIngredients;
    }

    async calculateProductConsumptions(
        tenantId: string,
        productId: string,
        quantity: number,
    ): Promise<ConsumptionDetail[]> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientNames = Array.from(flatIngredients.keys());
        if (ingredientNames.length === 0) return [];

        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                name: { in: ingredientNames },
            },
            select: {
                id: true,
                name: true,
                activeSkuId: true,
            },
        });

        const result: ConsumptionDetail[] = [];
        for (const ingredient of ingredients) {
            const totalConsumed = (flatIngredients.get(ingredient.name) || 0) * quantity;
            if (totalConsumed > 0) {
                result.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    activeSkuId: ingredient.activeSkuId,
                    totalConsumed,
                });
            }
        }

        return result;
    }

    private async getIngredientsWithActiveSku(tenantId: string): Promise<Map<string, IngredientWithActiveSku>> {
        const ingredients = await this.prisma.ingredient.findMany({
            where: { tenantId, deletedAt: null },
            include: {
                activeSku: true,
            },
        });

        return new Map(ingredients.map((i) => [i.name, i as IngredientWithActiveSku]));
    }
}
