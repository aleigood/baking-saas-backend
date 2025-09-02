import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
    Dough,
    DoughIngredient,
    Ingredient,
    Product,
    ProductIngredient,
    ProductIngredientType,
    RecipeFamily,
    RecipeVersion,
} from '@prisma/client';

interface ConsumptionDetail {
    ingredientId: string;
    ingredientName: string;
    activeSkuId: string | null;
    totalConsumed: number; // in grams
}

export interface CalculatedIngredientInfo {
    name: string;
    ratio: number;
    weightInGrams: number;
    pricePerKg: number;
    cost: number;
}

export interface CalculatedDoughGroup {
    name: string;
    ingredients: CalculatedIngredientInfo[];
    procedure?: string[];
    totalCost: number;
}

export interface CalculatedExtraIngredientInfo {
    id: string;
    name: string;
    type: string;
    cost: number;
    weightInGrams: number;
    ratio?: number;
}

export interface CalculatedProductCostDetails {
    totalCost: number;
    doughGroups: CalculatedDoughGroup[];
    extraIngredients: CalculatedExtraIngredientInfo[];
    groupedExtraIngredients: Record<string, CalculatedExtraIngredientInfo[]>;
}

// [核心修改] 为 CalculatedRecipeIngredient 接口增加可选的 brand 和 isRecipe 字段
export interface CalculatedRecipeIngredient {
    name: string;
    weightInGrams: number;
    brand?: string | null;
    isRecipe: boolean; // 新增字段，用于标识该原料是否为另一个配方
}

// [新增] 为前置准备任务定义新的类型接口
export interface CalculatedRecipeDetails {
    id: string;
    name: string;
    totalWeight: number;
    procedure: string[];
    ingredients: CalculatedRecipeIngredient[];
}

type FullDoughIngredient = DoughIngredient & {
    ingredient: Ingredient | null;
    linkedPreDough:
        | (RecipeFamily & {
              versions: (RecipeVersion & {
                  doughs: (Dough & {
                      ingredients: (DoughIngredient & {
                          ingredient: Ingredient | null;
                      })[];
                  })[];
              })[];
          })
        | null;
};

type FullProductIngredient = ProductIngredient & {
    ingredient: Ingredient | null;
    linkedExtra: RecipeFamily | null;
};

type FullRecipeVersion = RecipeVersion & {
    doughs: (Dough & {
        ingredients: FullDoughIngredient[];
    })[];
};

type FullProduct = Product & {
    recipeVersion: FullRecipeVersion & { family: RecipeFamily };
    ingredients: FullProductIngredient[];
};

@Injectable()
export class CostingService {
    constructor(private readonly prisma: PrismaService) {}

    // [新增] 新增一个公共方法，用于计算任何配方在指定总重下的原料明细
    // (New: Add a public method to calculate ingredient details for any recipe at a specified total weight)
    async getCalculatedRecipeDetails(
        tenantId: string,
        recipeFamilyId: string,
        totalWeight: number,
    ): Promise<CalculatedRecipeDetails> {
        const recipeFamily = await this.prisma.recipeFamily.findFirst({
            where: { id: recipeFamilyId, tenantId },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        doughs: {
                            include: {
                                ingredients: {
                                    include: {
                                        // [核心修改] 在查询原料时，预加载其激活的SKU信息，并同时加载linkedPreDough
                                        ingredient: {
                                            include: {
                                                activeSku: true,
                                            },
                                        },
                                        linkedPreDough: true, // 新增：加载关联的预制面团配方
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!recipeFamily || !recipeFamily.versions[0]?.doughs[0]) {
            throw new NotFoundException('配方或其激活的版本不存在');
        }

        const activeVersion = recipeFamily.versions[0];
        const mainDough = activeVersion.doughs[0];

        // [核心修复] 增加对 null 值的处理，使用 '?? 0'
        const totalRatio = mainDough.ingredients.reduce((sum, ing) => sum + (ing.ratio ?? 0), 0);
        if (totalRatio === 0) {
            return {
                id: recipeFamily.id,
                name: recipeFamily.name,
                totalWeight,
                procedure: mainDough.procedure,
                ingredients: [],
            };
        }

        const weightPerRatioPoint = new Prisma.Decimal(totalWeight).div(totalRatio);

        // [核心修改] 更新原料计算逻辑以区分普通原料和自制配方原料
        const calculatedIngredients = mainDough.ingredients
            .map((ing) => {
                // [核心修复] 增加对 null 值的处理，使用 '?? 0'
                const weight = weightPerRatioPoint.mul(ing.ratio ?? 0);

                // 如果成分是另一个配方（例如预制面团）
                if (ing.linkedPreDough) {
                    return {
                        name: ing.linkedPreDough.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: true, // 明确标识为自制配方
                        brand: null, // 自制配方没有品牌
                    };
                }
                // 如果成分是普通原料
                else if (ing.ingredient) {
                    return {
                        name: ing.ingredient.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: false, // 明确标识为普通原料
                        brand: ing.ingredient.activeSku?.brand, // 返回其品牌信息
                    };
                }
                return null; // 如果一个成分既不是普通原料也不是配方，则过滤掉
            })
            .filter(Boolean) as CalculatedRecipeIngredient[];

        return {
            id: recipeFamily.id,
            name: recipeFamily.name,
            totalWeight,
            procedure: mainDough.procedure,
            ingredients: calculatedIngredients,
        };
    }

    async getProductCostHistory(tenantId: string, productId: string) {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        if (ingredientIds.length === 0) return [];

        const ingredientsWithSkus = await this.prisma.ingredient.findMany({
            where: { tenantId, id: { in: ingredientIds }, deletedAt: null },
            select: { id: true, skus: { select: { id: true } } },
        });

        const allSkuIds = ingredientsWithSkus.flatMap((i) => i.skus.map((s) => s.id));
        if (allSkuIds.length === 0) {
            const currentCostResult = await this.calculateProductCost(tenantId, productId);
            return [{ cost: Number(currentCostResult.totalCost), date: new Date().toISOString().split('T')[0] }];
        }

        const distinctDates = await this.prisma.procurementRecord.findMany({
            where: { skuId: { in: allSkuIds } },
            orderBy: { purchaseDate: 'desc' },
            select: { purchaseDate: true },
            distinct: ['purchaseDate'],
            take: 9, // [修改] 将 take 从 30 改为 9，这样加上当前成本，总共返回 10 个数据点
        });

        if (distinctDates.length === 0) {
            const currentCostResult = await this.calculateProductCost(tenantId, productId);
            return [{ cost: Number(currentCostResult.totalCost), date: new Date().toISOString().split('T')[0] }];
        }

        const costChangeDates = distinctDates.map((p) => p.purchaseDate).sort((a, b) => a.getTime() - b.getTime());

        const costHistory: { cost: number; date: string }[] = [];

        for (const date of costChangeDates) {
            let snapshotTotalCost = new Prisma.Decimal(0);
            for (const [id, weight] of flatIngredients.entries()) {
                const ingredientInfo = ingredientsWithSkus.find((ing) => ing.id === id);
                if (!ingredientInfo || ingredientInfo.skus.length === 0) continue;

                const skuIds = ingredientInfo.skus.map((s) => s.id);
                const latestProcurement = await this.prisma.procurementRecord.findFirst({
                    where: {
                        skuId: { in: skuIds },
                        purchaseDate: { lte: date },
                    },
                    orderBy: { purchaseDate: 'desc' },
                    include: { sku: { select: { specWeightInGrams: true } } },
                });

                if (latestProcurement) {
                    const pricePerGram = new Prisma.Decimal(latestProcurement.pricePerPackage).div(
                        latestProcurement.sku.specWeightInGrams,
                    );
                    snapshotTotalCost = snapshotTotalCost.add(pricePerGram.mul(weight));
                }
            }
            costHistory.push({
                cost: snapshotTotalCost.toDP(4).toNumber(),
                date: date.toISOString().split('T')[0],
            });
        }

        const currentCostResult = await this.calculateProductCost(tenantId, productId);
        const today = new Date().toISOString().split('T')[0];
        const lastHistoryEntry = costHistory[costHistory.length - 1];

        if (
            !lastHistoryEntry ||
            lastHistoryEntry.date !== today ||
            lastHistoryEntry.cost !== Number(currentCostResult.totalCost)
        ) {
            costHistory.push({ cost: Number(currentCostResult.totalCost), date: today });
        }

        return costHistory;
    }

    async getIngredientCostHistory(tenantId: string, ingredientId: string) {
        const ingredient = await this.prisma.ingredient.findFirst({
            where: { id: ingredientId, tenantId },
            include: { skus: true },
        });

        if (!ingredient) {
            throw new NotFoundException('原料不存在');
        }

        const skuIds = ingredient.skus.map((sku) => sku.id);
        if (skuIds.length === 0) {
            return [];
        }

        const procurementRecords = await this.prisma.procurementRecord.findMany({
            where: { skuId: { in: skuIds } },
            include: { sku: true },
            orderBy: { purchaseDate: 'desc' },
            take: 10,
        });

        if (procurementRecords.length === 0) {
            return [];
        }

        const costHistory = procurementRecords.map((record) => {
            const pricePerPackage = new Prisma.Decimal(record.pricePerPackage);
            const specWeightInGrams = new Prisma.Decimal(record.sku.specWeightInGrams);
            if (specWeightInGrams.isZero()) {
                return { cost: 0 };
            }
            const costPerKg = pricePerPackage.div(specWeightInGrams).mul(1000);
            return {
                cost: costPerKg.toDP(2).toNumber(),
            };
        });

        return costHistory.reverse();
    }

    async getIngredientUsageHistory(tenantId: string, ingredientId: string) {
        const ingredientExists = await this.prisma.ingredient.findFirst({
            where: { id: ingredientId, tenantId },
        });
        if (!ingredientExists) {
            throw new NotFoundException('原料不存在');
        }

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

        return consumptionLogs.map((log) => ({ cost: log.quantityInGrams })).reverse();
    }

    async getCalculatedProductDetails(tenantId: string, productId: string): Promise<CalculatedProductCostDetails> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getWeightedAveragePricePerGramMap(tenantId, ingredientIds);

        const getPricePerKg = (id: string) => {
            const pricePerGram = pricePerGramMap.get(id);
            return pricePerGram ? pricePerGram.mul(1000).toDP(2).toNumber() : 0;
        };

        const doughGroups: CalculatedDoughGroup[] = [];
        let totalCost = new Prisma.Decimal(0);
        let totalFlourWeight = new Prisma.Decimal(0);

        // [核心修改] 增加 parentConversionFactor 参数，用于在递归时计算正确的有效比例
        const processDough = (
            dough: FullRecipeVersion['doughs'][0],
            doughWeight: number,
            parentConversionFactor: Prisma.Decimal,
            isMainDough: boolean, // 新增一个标志来识别是否是主面团
        ): CalculatedDoughGroup => {
            const group: CalculatedDoughGroup = {
                // [核心修改] 如果是主面团，则使用产品名称，否则使用面团（配方）名称
                name: isMainDough ? product.name : dough.name,
                ingredients: [],
                procedure: dough.procedure,
                totalCost: 0,
            };

            // [核心修正] 根据损耗率计算投料总重
            const lossRatio = dough.lossRatio || 0;
            // 确保不会除以0或负数
            const divisor = 1 - lossRatio;
            if (divisor <= 0) {
                // 如果损耗率大于等于100%，则无法生产，返回空组
                return group;
            }
            const adjustedDoughWeight = new Prisma.Decimal(doughWeight).div(divisor);

            // [核心修复] 增加对 null 值的处理，使用 '?? 0'
            const totalRatio = dough.ingredients.reduce((sum, i) => sum + (i.ratio ?? 0), 0);
            if (totalRatio === 0) return group;

            const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);

            for (const ingredient of dough.ingredients) {
                // [核心修复] 增加对 null 值的处理，使用 '?? 0'
                const weight = weightPerRatioPoint.mul(ingredient.ratio ?? 0);
                const preDough = ingredient.linkedPreDough?.versions?.[0];

                if (preDough && preDough.doughs[0]) {
                    const preDoughRecipe = preDough.doughs[0];
                    // [核心修复] 增加对 null 值的处理，使用 '?? 0'
                    const preDoughTotalRatio = preDoughRecipe.ingredients.reduce((sum, i) => sum + (i.ratio ?? 0), 0);

                    // [核心修改] 计算新的转换系数，用于下一层递归
                    let newConversionFactor = parentConversionFactor;
                    if (preDoughTotalRatio > 0) {
                        // 新系数 = 父级系数 * (当前预制面团在父级中的比例 / 预制面团自身的总比例)
                        newConversionFactor = parentConversionFactor.mul(
                            // [核心修复] 增加对 null 值的处理，使用 '?? 0'
                            new Prisma.Decimal(ingredient.ratio ?? 0).div(preDoughTotalRatio),
                        );
                    }

                    const preDoughGroup = processDough(
                        preDoughRecipe as FullRecipeVersion['doughs'][0],
                        weight.toNumber(),
                        newConversionFactor, // 传递新的转换系数
                        false, // 预制面团不是主面团
                    );
                    preDoughGroup.name = `${ingredient.linkedPreDough?.name} (用量: ${weight.toDP(1).toNumber()}g)`;
                    doughGroups.push(preDoughGroup);
                } else if (ingredient.ingredient) {
                    const pricePerKg = getPricePerKg(ingredient.ingredient.id);
                    const cost = new Prisma.Decimal(pricePerKg).div(1000).mul(weight);

                    // [核心修改] 使用转换系数计算相对于主面团的有效比例
                    // [核心修复] 增加对 null 值的处理，使用 '?? 0'
                    const effectiveRatio = new Prisma.Decimal(ingredient.ratio ?? 0).mul(parentConversionFactor);

                    group.ingredients.push({
                        name: ingredient.ingredient.name,
                        ratio: effectiveRatio.toNumber(), // 使用计算出的有效比例，而不是原始比例
                        weightInGrams: weight.toNumber(),
                        pricePerKg: pricePerKg, // [核心修复] 直接返回数字，而不是字符串
                        cost: cost.toDP(2).toNumber(),
                    });
                    group.totalCost = new Prisma.Decimal(group.totalCost).add(cost).toNumber();

                    if (ingredient.ingredient.isFlour) {
                        totalFlourWeight = totalFlourWeight.add(weight);
                    }
                }
            }
            totalCost = totalCost.add(group.totalCost);
            return group;
        };

        product.recipeVersion.doughs.forEach((dough, index) => {
            // [核心修改] 初始调用时，转换系数为1，并标记第一个 dough 为主面团
            const mainDoughGroup = processDough(dough, product.baseDoughWeight, new Prisma.Decimal(1), index === 0);
            if (mainDoughGroup.ingredients.length > 0) {
                doughGroups.push(mainDoughGroup);
            }
        });

        const getProductIngredientTypeName = (type: ProductIngredientType) => {
            const map = { MIX_IN: '搅拌原料', FILLING: '馅料', TOPPING: '表面装饰' };
            return map[type] || '附加原料';
        };

        const extraIngredients = (product.ingredients || []).map((ing) => {
            const name = ing.ingredient?.name || ing.linkedExtra?.name || '未知';
            const id = ing.ingredient?.id || ing.linkedExtra?.id || ing.id;
            const pricePerKg = getPricePerKg(id);
            let finalWeightInGrams = new Prisma.Decimal(0);
            if (ing.type === 'MIX_IN' && ing.ratio) {
                finalWeightInGrams = totalFlourWeight.mul(ing.ratio);
            } else if (ing.weightInGrams) {
                finalWeightInGrams = new Prisma.Decimal(ing.weightInGrams);
            }
            const cost = new Prisma.Decimal(pricePerKg).div(1000).mul(finalWeightInGrams);
            totalCost = totalCost.add(cost);

            return {
                id: ing.id,
                name: name,
                type: getProductIngredientTypeName(ing.type),
                cost: cost.toDP(2).toNumber(),
                // [FIX] 移除 .toDP(1)，保留完整精度
                // (FIX: Remove .toDP(1) to preserve full precision)
                weightInGrams: finalWeightInGrams.toNumber(),
                ratio: ing.ratio ?? undefined,
            };
        });

        const allExtraIngredients = [
            {
                id: 'dough-summary',
                name: '基础面团',
                type: '面团',
                cost: doughGroups.reduce((sum, g) => sum + g.totalCost, 0),
                weightInGrams: product.baseDoughWeight,
            },
            ...extraIngredients,
        ];

        const groupedExtraIngredients = allExtraIngredients.reduce(
            (acc, ing) => {
                const typeKey = ing.type || '其他';
                if (!acc[typeKey]) acc[typeKey] = [];
                acc[typeKey].push(ing);
                return acc;
            },
            {} as Record<string, CalculatedExtraIngredientInfo[]>,
        );

        return {
            totalCost: totalCost.toDP(2).toNumber(),
            doughGroups,
            extraIngredients: allExtraIngredients,
            groupedExtraIngredients,
        };
    }

    async calculateProductCost(tenantId: string, productId: string) {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getWeightedAveragePricePerGramMap(tenantId, ingredientIds);

        let totalCost = new Prisma.Decimal(0);

        for (const [id, weight] of flatIngredients.entries()) {
            const pricePerGram = pricePerGramMap.get(id);
            if (pricePerGram) {
                const cost = pricePerGram.mul(weight);
                totalCost = totalCost.add(cost);
            }
        }

        return {
            productId: product.id,
            productName: product.name,
            totalCost: totalCost.toDP(4).toNumber(), // [核心修复] 使用 .toNumber() 返回数字
        };
    }

    async calculateIngredientCostBreakdown(
        tenantId: string,
        productId: string,
    ): Promise<{ name: string; value: number }[]> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getWeightedAveragePricePerGramMap(tenantId, ingredientIds);
        const ingredients = await this.prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
        const ingredientMap = new Map(ingredients.map((i) => [i.id, i]));

        const costBreakdown: { name: string; value: number }[] = [];

        for (const [id, weight] of flatIngredients.entries()) {
            const pricePerGram = pricePerGramMap.get(id);
            const ingredient = ingredientMap.get(id);
            if (pricePerGram && ingredient) {
                const cost = pricePerGram.mul(weight);
                costBreakdown.push({
                    name: ingredient.name,
                    value: cost.toDP(4).toNumber(),
                });
            }
        }

        const sortedBreakdown = costBreakdown.sort((a, b) => b.value - a.value);

        if (sortedBreakdown.length > 4) {
            const top4 = sortedBreakdown.slice(0, 4);
            const otherValue = sortedBreakdown.slice(4).reduce((sum, item) => sum + item.value, 0);
            if (otherValue > 0) {
                return [...top4, { name: '其他', value: otherValue }];
            }
            return top4;
        }

        return sortedBreakdown;
    }

    private async getFullProduct(tenantId: string, productId: string): Promise<FullProduct | null> {
        return this.prisma.product.findFirst({
            where: { id: productId, recipeVersion: { family: { tenantId } } },
            include: {
                recipeVersion: {
                    include: {
                        family: true,
                        doughs: {
                            include: {
                                ingredients: {
                                    include: {
                                        ingredient: true,
                                        linkedPreDough: {
                                            include: {
                                                versions: {
                                                    where: { isActive: true },
                                                    include: {
                                                        doughs: {
                                                            include: {
                                                                ingredients: {
                                                                    include: {
                                                                        ingredient: true,
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
                    },
                },
                ingredients: {
                    include: {
                        ingredient: true,
                        linkedExtra: true,
                    },
                },
            },
        }) as Promise<FullProduct | null>;
    }

    private async _getFlattenedIngredients(product: FullProduct): Promise<Map<string, number>> {
        const flattenedIngredients = new Map<string, number>(); // Map<ingredientId, weightInGrams>

        const processDough = (dough: FullRecipeVersion['doughs'][0], doughWeight: number) => {
            const lossRatio = dough.lossRatio || 0;
            const divisor = 1 - lossRatio;
            if (divisor <= 0) {
                return;
            }
            const adjustedDoughWeight = new Prisma.Decimal(doughWeight).div(divisor);

            // [核心修复] 增加对 null 值的处理，使用 '?? 0'
            const totalRatio = dough.ingredients.reduce((sum, ing) => sum + (ing.ratio ?? 0), 0);
            if (totalRatio === 0) return;

            const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);

            for (const ing of dough.ingredients) {
                // [核心修复] 增加对 null 值的处理，使用 '?? 0'
                const ingredientWeight = weightPerRatioPoint.mul(ing.ratio ?? 0).toNumber();
                const preDough = ing.linkedPreDough?.versions?.[0];

                if (preDough && preDough.doughs[0]) {
                    processDough(preDough.doughs[0] as FullRecipeVersion['doughs'][0], ingredientWeight);
                } else if (ing.ingredientId) {
                    const currentWeight = flattenedIngredients.get(ing.ingredientId) || 0;
                    flattenedIngredients.set(ing.ingredientId, currentWeight + ingredientWeight);
                }
            }
        };

        product.recipeVersion.doughs.forEach((dough) => {
            processDough(dough, product.baseDoughWeight);
        });

        let totalFlourWeight = new Prisma.Decimal(0);
        const ingredientIds = Array.from(flattenedIngredients.keys());
        const ingredients = await this.prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
        const ingredientMap = new Map(ingredients.map((i) => [i.id, i]));

        for (const [id, weight] of flattenedIngredients.entries()) {
            const ingredientInfo = ingredientMap.get(id);
            if (ingredientInfo?.isFlour) {
                totalFlourWeight = totalFlourWeight.add(weight);
            }
        }

        product.ingredients?.forEach((pIng) => {
            if (pIng.ingredientId) {
                let finalWeightInGrams = 0;
                if (pIng.weightInGrams) {
                    finalWeightInGrams = pIng.weightInGrams;
                } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                    finalWeightInGrams = totalFlourWeight.mul(pIng.ratio).toNumber();
                }

                if (finalWeightInGrams > 0) {
                    const currentWeight = flattenedIngredients.get(pIng.ingredientId) || 0;
                    flattenedIngredients.set(pIng.ingredientId, currentWeight + finalWeightInGrams);
                }
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
        const ingredientIds = Array.from(flatIngredients.keys());
        if (ingredientIds.length === 0) return [];

        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                name: true,
                activeSkuId: true,
            },
        });

        const result: ConsumptionDetail[] = [];
        for (const ingredient of ingredients) {
            const totalConsumed = (flatIngredients.get(ingredient.id) || 0) * quantity;
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

    private async _getWeightedAveragePricePerGramMap(
        tenantId: string,
        ingredientIds: string[],
    ): Promise<Map<string, Prisma.Decimal>> {
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                currentStockInGrams: true,
                currentStockValue: true,
            },
        });

        const priceMap = new Map<string, Prisma.Decimal>();

        for (const ingredient of ingredients) {
            if (ingredient.currentStockInGrams > 0 && ingredient.currentStockValue.gt(0)) {
                const pricePerGram = new Prisma.Decimal(ingredient.currentStockValue).div(
                    ingredient.currentStockInGrams,
                );
                priceMap.set(ingredient.id, pricePerGram);
            } else {
                priceMap.set(ingredient.id, new Prisma.Decimal(0));
            }
        }

        return priceMap;
    }
}
