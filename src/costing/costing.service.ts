import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
// [修复] 导入所有需要的 Prisma 模型类型
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
    totalConsumed: number;
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

// [修复] 为 FullProduct 类型添加 ingredients 属性
type FullProduct = Product & {
    recipeVersion: FullRecipeVersion;
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
     * [核心新增] 获取产品成本的历史变化记录
     * @param tenantId 租户ID
     * @param productId 产品ID
     * @returns 一个包含每次成本变化点的数组
     */
    async getProductCostHistory(tenantId: string, productId: string) {
        // 1. 获取产品的完整配方信息，包括所有嵌套的面种
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        // 2. 将配方扁平化，计算出制作一个单位产品所需每种基础原料的克重
        const flatIngredients = this._getFlattenedIngredients(product);
        const ingredientNames = Array.from(flatIngredients.keys());
        if (ingredientNames.length === 0) return [];

        // 3. 找到这些原料，并获取它们当前激活的SKU ID
        const ingredients = await this.prisma.ingredient.findMany({
            where: { tenantId, name: { in: ingredientNames }, deletedAt: null },
            select: { name: true, activeSkuId: true },
        });

        const activeSkuIds = ingredients.map((i) => i.activeSkuId).filter((id): id is string => !!id);
        if (activeSkuIds.length === 0) {
            // 如果没有任何SKU，则无法计算成本
            return [];
        }

        // 4. 获取所有相关SKU的历史采购记录，并按日期排序
        const procurementRecords = await this.prisma.procurementRecord.findMany({
            where: { skuId: { in: activeSkuIds } },
            include: { sku: true },
            orderBy: { purchaseDate: 'asc' },
        });

        if (procurementRecords.length === 0) {
            // 如果没有采购记录，则无法生成历史，返回空数组
            return [];
        }

        // 5. 迭代采购记录，在每个价格变化点重新计算总成本
        const costHistory: { cost: number }[] = [];
        const currentPricesPerGram = new Map<string, Decimal>(); // Map<skuId, pricePerGram>

        for (const record of procurementRecords) {
            // 更新价格表
            currentPricesPerGram.set(
                record.skuId,
                new Decimal(record.pricePerPackage).div(record.sku.specWeightInGrams),
            );

            let totalCost = new Decimal(0);

            // 使用当前的价格表和扁平化的原料用量，重新计算总成本
            for (const [name, weight] of flatIngredients.entries()) {
                const ingredient = ingredients.find((i) => i.name === name);
                if (ingredient?.activeSkuId && currentPricesPerGram.has(ingredient.activeSkuId)) {
                    const pricePerGram = currentPricesPerGram.get(ingredient.activeSkuId)!;
                    totalCost = totalCost.add(pricePerGram.mul(weight));
                }
            }

            // 将计算出的成本点添加到历史记录中
            costHistory.push({ cost: totalCost.toDP(4).toNumber() });
        }

        return costHistory;
    }

    /**
     * [新增] 获取单个原料成本的历史变化记录
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

        // 2. 获取该原料所有SKU的历史采购记录，并按日期排序
        const procurementRecords = await this.prisma.procurementRecord.findMany({
            where: { skuId: { in: skuIds } },
            include: { sku: true }, // 包含SKU信息以获取规格重量
            orderBy: { purchaseDate: 'asc' },
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

        return costHistory;
    }

    /**
     * [核心重构] 计算单个产品的当前成本，现在调用新的辅助函数
     */
    async calculateProductCost(tenantId: string, productId: string) {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = this._getFlattenedIngredients(product);
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
     * [核心新增] 私有辅助方法：获取一个产品的完整配方信息，包括所有嵌套的面种
     */
    private async getFullProduct(tenantId: string, productId: string): Promise<FullProduct | null> {
        return this.prisma.product.findFirst({
            where: { id: productId, recipeVersion: { family: { tenantId }, isActive: true } },
            include: {
                recipeVersion: {
                    include: {
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
    private _getFlattenedIngredients(product: FullProduct): Map<string, number> {
        const flattenedIngredients = new Map<string, number>(); // Map<ingredientName, weightInGrams>

        // [修复] 移除未使用的 isMainDough 参数，并为 dough 参数添加精确类型
        const processDough = (dough: ProcessableDough, doughWeight: number) => {
            let totalFlourRatio = 0;
            dough.ingredients.forEach((ing) => {
                if (ing.isFlour) {
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

        const flatIngredients = this._getFlattenedIngredients(product);
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
