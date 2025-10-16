import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
    Prisma,
    RecipeComponent,
    ComponentIngredient,
    Ingredient,
    Product,
    ProductIngredient,
    ProductIngredientType,
    RecipeFamily,
    RecipeType,
    RecipeVersion,
    RecipeCategory,
    IngredientType,
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
    extraInfo?: string;
}

export interface CalculatedComponentGroup {
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
    extraInfo?: string;
}

export interface CalculatedProductCostDetails {
    totalCost: number;
    componentGroups: CalculatedComponentGroup[];
    extraIngredients: CalculatedExtraIngredientInfo[];
    groupedExtraIngredients: Record<string, CalculatedExtraIngredientInfo[]>;
    productProcedure: string[];
}

export interface CalculatedRecipeIngredient {
    name: string;
    weightInGrams: number;
    brand?: string | null;
    isRecipe: boolean;
}

export interface CalculatedRecipeDetails {
    id: string;
    name: string;
    type: RecipeType;
    // [核心修复] 字段名改回 totalWeight，代表为达成目标产量，需要投入的原料总重 (含损耗)
    totalWeight: number;
    // [核心修复] 字段名改回 targetWeight，代表目标产出净重 (不含损耗)
    targetWeight: number;
    procedure: string[];
    ingredients: CalculatedRecipeIngredient[];
}

// 深入定义类型以支持递归查询
type FullComponentIngredient = ComponentIngredient & {
    ingredient: Ingredient | null;
    linkedPreDough:
        | (RecipeFamily & {
              versions: (RecipeVersion & {
                  components: (RecipeComponent & {
                      ingredients: (ComponentIngredient & {
                          ingredient: Ingredient | null;
                      })[];
                  })[];
              })[];
          })
        | null;
};

type FullRecipeVersion = RecipeVersion & {
    components: (RecipeComponent & {
        ingredients: FullComponentIngredient[];
    })[];
};

// 深入定义 FullProductIngredient 以支持 linkedExtra 的递归损耗计算
type FullProductIngredient = ProductIngredient & {
    ingredient: Ingredient | null;
    linkedExtra:
        | (RecipeFamily & {
              versions: (RecipeVersion & {
                  components: (RecipeComponent & {
                      ingredients: (ComponentIngredient & { ingredient: Ingredient | null })[];
                  })[];
              })[];
          })
        | null;
};

type FullProduct = Product & {
    recipeVersion: FullRecipeVersion & { family: RecipeFamily };
    ingredients: FullProductIngredient[];
};

@Injectable()
export class CostingService {
    constructor(private readonly prisma: PrismaService) {}

    async getCalculatedRecipeDetails(
        tenantId: string,
        recipeFamilyId: string,
        totalWeight: number, // 此处传入的 totalWeight 参数被明确定义为“目标产出重量 (Output)”
    ): Promise<CalculatedRecipeDetails> {
        const outputWeightTarget = new Prisma.Decimal(totalWeight);

        const recipeFamily = await this.prisma.recipeFamily.findFirst({
            where: { id: recipeFamilyId, tenantId },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        components: {
                            include: {
                                ingredients: {
                                    include: {
                                        ingredient: {
                                            include: {
                                                activeSku: true,
                                            },
                                        },
                                        linkedPreDough: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!recipeFamily || !recipeFamily.versions[0]?.components[0]) {
            throw new NotFoundException('配方或其激活的版本不存在');
        }

        const activeVersion = recipeFamily.versions[0];
        const mainComponent = activeVersion.components[0];

        // [核心逻辑] 根据损耗率，从“目标产出重量”反推计算“所需投入原料总重”
        // Input = Output / (1 - lossRatio)
        const lossRatio = new Prisma.Decimal(mainComponent.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);

        const requiredInputWeight = divisor.isZero() ? outputWeightTarget : outputWeightTarget.div(divisor);

        const totalRatio = mainComponent.ingredients.reduce(
            (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
            new Prisma.Decimal(0),
        );

        if (totalRatio.isZero()) {
            return {
                id: recipeFamily.id,
                name: recipeFamily.name,
                type: recipeFamily.type,
                totalWeight: outputWeightTarget.toNumber(), // 如果没有配比，投入=产出
                targetWeight: outputWeightTarget.toNumber(),
                procedure: mainComponent.procedure,
                ingredients: [],
            };
        }

        const weightPerRatioPoint = requiredInputWeight.div(totalRatio);

        const calculatedIngredients = mainComponent.ingredients
            .map((ing) => {
                const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                if (ing.linkedPreDough) {
                    return {
                        name: ing.linkedPreDough.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: true,
                        brand: null,
                    };
                } else if (ing.ingredient) {
                    return {
                        name: ing.ingredient.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: false,
                        brand: ing.ingredient.activeSku?.brand,
                    };
                }
                return null;
            })
            .filter(Boolean) as CalculatedRecipeIngredient[];

        const response: CalculatedRecipeDetails = {
            id: recipeFamily.id,
            name: recipeFamily.name,
            type: recipeFamily.type,
            // [核心修复] 返回值清晰区分 totalWeight 和 targetWeight
            totalWeight: requiredInputWeight.toDP(2).toNumber(),
            targetWeight: outputWeightTarget.toDP(2).toNumber(),
            procedure: mainComponent.procedure,
            ingredients: calculatedIngredients,
        };

        return response;
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
            take: 9,
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

        return consumptionLogs.map((log) => ({ cost: log.quantityInGrams.toNumber() })).reverse();
    }

    private _parseProcedureForNotes(
        procedure: string[] | undefined | null,
        baseWeightForPercentage: Prisma.Decimal,
    ): {
        cleanedProcedure: string[];
        ingredientNotes: Map<string, string>;
    } {
        if (!procedure) {
            return { cleanedProcedure: [], ingredientNotes: new Map() };
        }
        const ingredientNotes = new Map<string, string>();
        const noteRegex = /@(?:\[)?(.*?)(?:\])?[(（](.*?)[)）]/g;
        const percentageRegex = /\[(\d+(?:\.\d+)?)%\]/g;

        const cleanedProcedure = procedure
            .map((step) => {
                // 第一步：替换百分比
                const processedStep = step.replace(percentageRegex, (match: string, p1: string) => {
                    const percentage = new Prisma.Decimal(p1);
                    const calculatedWeight = baseWeightForPercentage.mul(percentage.div(100));
                    return `${calculatedWeight.toDP(1).toNumber()}克`;
                });

                // 第二步：提取注释
                const stepMatches = [...processedStep.matchAll(noteRegex)];
                for (const match of stepMatches) {
                    const [, ingredientName, note] = match;
                    if (ingredientName && note) {
                        ingredientNotes.set(ingredientName.trim(), note.trim());
                    }
                }

                // 第三步：清理步骤文本中的注释
                const cleanedStepText = processedStep.replace(noteRegex, '').trim();

                if (cleanedStepText === '') {
                    return null;
                }

                return cleanedStepText;
            })
            .filter((step): step is string => step !== null);

        return { cleanedProcedure, ingredientNotes };
    }

    async getCalculatedProductDetails(tenantId: string, productId: string): Promise<CalculatedProductCostDetails> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        // [核心修改] 调用“理论计算”方法，用于成本核算，忽略所有损耗率
        const flatIngredients = await this._getFlattenedIngredientsTheoretical(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getPricePerGramMap(tenantId, ingredientIds);

        const getPricePerKg = (id: string) => {
            const pricePerGram = pricePerGramMap.get(id);
            return pricePerGram ? pricePerGram.mul(1000).toDP(2).toNumber() : 0;
        };

        const componentGroups: CalculatedComponentGroup[] = [];
        let totalCost = new Prisma.Decimal(0);

        const processComponent = (
            component: FullRecipeVersion['components'][0],
            componentWeight: Prisma.Decimal,
            parentConversionFactor: Prisma.Decimal,
            isBaseComponent: boolean,
            flourWeightReference: Prisma.Decimal,
        ): CalculatedComponentGroup => {
            const group: CalculatedComponentGroup = {
                name: isBaseComponent ? '基础组件' : component.name,
                ingredients: [],
                procedure: [],
                totalCost: 0,
            };

            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );

            if (totalRatio.isZero() && !isBaseComponent) return group;

            const currentFlourWeight = isBaseComponent ? flourWeightReference : componentWeight.div(totalRatio);

            const { cleanedProcedure, ingredientNotes } = this._parseProcedureForNotes(
                component.procedure,
                currentFlourWeight,
            );
            group.procedure = cleanedProcedure;

            for (const ingredient of component.ingredients) {
                const preDough = ingredient.linkedPreDough?.versions?.[0];

                let weight: Prisma.Decimal;
                if (preDough && ingredient.flourRatio) {
                    const preDoughRecipe = preDough.components[0];
                    const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                        (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                        new Prisma.Decimal(0),
                    );
                    const flourForPreDough = flourWeightReference.mul(new Prisma.Decimal(ingredient.flourRatio));
                    weight = flourForPreDough.mul(preDoughTotalRatio);
                } else {
                    weight = currentFlourWeight.mul(new Prisma.Decimal(ingredient.ratio ?? 0));
                }

                if (preDough && preDough.components[0]) {
                    const preDoughRecipe = preDough.components[0];
                    let newConversionFactor: Prisma.Decimal;
                    if (ingredient.flourRatio && new Prisma.Decimal(ingredient.flourRatio).gt(0)) {
                        newConversionFactor = parentConversionFactor.mul(new Prisma.Decimal(ingredient.flourRatio));
                    } else {
                        const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                            (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        newConversionFactor = !preDoughTotalRatio.isZero()
                            ? parentConversionFactor.mul(
                                  new Prisma.Decimal(ingredient.ratio ?? 0).div(preDoughTotalRatio),
                              )
                            : parentConversionFactor;
                    }

                    const preDoughGroup = processComponent(
                        preDoughRecipe as FullRecipeVersion['components'][0],
                        weight,
                        newConversionFactor,
                        false,
                        flourWeightReference,
                    );
                    preDoughGroup.name = `${ingredient.linkedPreDough?.name}`;
                    componentGroups.push(preDoughGroup);
                } else if (ingredient.ingredient) {
                    const pricePerKg = getPricePerKg(ingredient.ingredient.id);
                    const cost = new Prisma.Decimal(pricePerKg).div(1000).mul(weight);

                    const effectiveRatio = new Prisma.Decimal(ingredient.ratio ?? 0).mul(parentConversionFactor);

                    const extraInfoParts: string[] = [];
                    const procedureNote = ingredientNotes.get(ingredient.ingredient.name);
                    if (procedureNote) {
                        extraInfoParts.push(procedureNote);
                    }

                    group.ingredients.push({
                        name: ingredient.ingredient.name,
                        ratio: effectiveRatio.toNumber(),
                        weightInGrams: weight.toNumber(),
                        pricePerKg: pricePerKg,
                        cost: cost.toDP(2).toNumber(),
                        extraInfo: extraInfoParts.length > 0 ? extraInfoParts.join('\n') : undefined,
                    });
                    group.totalCost = new Prisma.Decimal(group.totalCost).add(cost).toNumber();
                }
            }
            totalCost = totalCost.add(group.totalCost);
            return group;
        };

        const baseComponent = product.recipeVersion.components[0];
        const calculateTotalRatioForMain = (component: FullRecipeVersion['components'][0]): Prisma.Decimal => {
            return component.ingredients.reduce((sum, i) => {
                if (i.flourRatio && i.linkedPreDough) {
                    const preDough = i.linkedPreDough.versions?.[0]?.components?.[0];
                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        return sum.add(new Prisma.Decimal(i.flourRatio).mul(preDoughTotalRatio));
                    }
                }
                return sum.add(new Prisma.Decimal(i.ratio ?? 0));
            }, new Prisma.Decimal(0));
        };

        const baseComponentTotalRatio = calculateTotalRatioForMain(baseComponent);
        const adjustedBaseComponentWeight = new Prisma.Decimal(product.baseDoughWeight);

        const flourWeightReference = !baseComponentTotalRatio.isZero()
            ? adjustedBaseComponentWeight.div(baseComponentTotalRatio)
            : new Prisma.Decimal(0);

        const baseComponentGroup = processComponent(
            baseComponent,
            new Prisma.Decimal(product.baseDoughWeight),
            new Prisma.Decimal(1),
            true,
            flourWeightReference,
        );

        if (baseComponentGroup.ingredients.length > 0) {
            baseComponentGroup.name =
                product.recipeVersion.family.category === RecipeCategory.BREAD
                    ? '主面团'
                    : product.recipeVersion.family.name;
            componentGroups.push(baseComponentGroup);
        }

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
                finalWeightInGrams = flourWeightReference.mul(new Prisma.Decimal(ing.ratio));
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
                weightInGrams: finalWeightInGrams.toNumber(),
                ratio: ing.ratio ? ing.ratio.toNumber() : undefined,
                extraInfo: undefined,
            };
        });

        const summaryRowName = product.recipeVersion.family.category === RecipeCategory.BREAD ? '基础面团' : '基础原料';
        const allExtraIngredients: CalculatedExtraIngredientInfo[] = [
            {
                id: 'component-summary',
                name: summaryRowName,
                type: '原料',
                cost: componentGroups.reduce((sum, g) => sum + g.totalCost, 0),
                weightInGrams: product.baseDoughWeight.toNumber(),
            },
            ...extraIngredients,
        ];

        const groupedExtraIngredients = allExtraIngredients.reduce(
            (acc, ing) => {
                const typeKey = ing.type || '其他';
                if (!acc[typeKey]) {
                    acc[typeKey] = [];
                }
                acc[typeKey].push(ing);
                return acc;
            },
            {} as Record<string, CalculatedExtraIngredientInfo[]>,
        );

        return {
            totalCost: totalCost.toDP(2).toNumber(),
            componentGroups: componentGroups,
            extraIngredients: allExtraIngredients,
            groupedExtraIngredients,
            productProcedure: product.procedure,
        };
    }

    async calculateProductCost(tenantId: string, productId: string) {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const flatIngredients = await this._getFlattenedIngredientsTheoretical(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getPricePerGramMap(tenantId, ingredientIds);

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
            totalCost: totalCost.toDP(4).toNumber(),
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

        const flatIngredients = await this._getFlattenedIngredientsTheoretical(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getPricePerGramMap(tenantId, ingredientIds);
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
                        components: {
                            include: {
                                ingredients: {
                                    include: {
                                        ingredient: true,
                                        linkedPreDough: {
                                            include: {
                                                versions: {
                                                    where: { isActive: true },
                                                    include: {
                                                        components: {
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
                        linkedExtra: {
                            include: {
                                versions: {
                                    where: { isActive: true },
                                    include: {
                                        components: {
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
        }) as Promise<FullProduct | null>;
    }

    /**
     * [核心函数] 计算生产一个产品所需的**所有基础原料的总投入量** (含损耗)。
     * 用于生产任务备料、前置准备任务等需要知道“我需要领多少料”的场景。
     * @param product 完整的产品对象
     * @returns Map<ingredientId, totalInputWeight>
     */
    private async _getFlattenedIngredients(product: FullProduct): Promise<Map<string, Prisma.Decimal>> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();

        // [核心重构] 这是一个递归函数，用于计算一个组件（面团、面种、馅料等）需要的所有基础原料的投入量
        const processComponentRecursively = (
            component: FullRecipeVersion['components'][0],
            requiredOutputWeight: Prisma.Decimal, // 目标产出净重
        ) => {
            // 步骤 1: 根据损耗率，从目标产出净重反推计算需要投入的原料总量
            const lossRatio = new Prisma.Decimal(component.lossRatio || 0);
            const divisor = new Prisma.Decimal(1).sub(lossRatio);
            if (divisor.isZero() || divisor.isNegative()) return;
            const totalInputWeight = requiredOutputWeight.div(divisor);

            // 步骤 2: 计算该组件内所有原料的“配方比例总和”
            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );
            if (totalRatio.isZero()) return;

            // 步骤 3: 计算出“每1%的配比”对应多少克重的原料
            const weightPerRatioPoint = totalInputWeight.div(totalRatio);

            // 步骤 4: 遍历组件内的每一种“原料”
            for (const ing of component.ingredients) {
                // 计算当前“原料”按配比需要投入的克重
                const ingredientInputWeight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                // 如果这个“原料”本身是另一个配方（如预制面种），则递归调用本函数
                if (ing.linkedPreDough) {
                    const preDoughComponent = ing.linkedPreDough.versions?.[0]?.components?.[0];
                    if (preDoughComponent) {
                        processComponentRecursively(
                            preDoughComponent as FullRecipeVersion['components'][0],
                            ingredientInputWeight, // 此时，对于下一层面种来说，这个投入量就是它的“目标产出量”
                        );
                    }
                } else if (ing.ingredientId) {
                    // 如果是基础原料（如面粉、水），则将其重量累加到最终的清单中
                    const currentWeight = flattenedIngredients.get(ing.ingredientId) || new Prisma.Decimal(0);
                    flattenedIngredients.set(ing.ingredientId, currentWeight.add(ingredientInputWeight));
                }
            }
        };

        // 从产品的主面团开始，进行第一次递归计算
        const mainComponent = product.recipeVersion.components[0];
        if (mainComponent) {
            // Product.baseDoughWeight 是最终产品需要的面团“净重”，作为递归的起点
            processComponentRecursively(mainComponent, new Prisma.Decimal(product.baseDoughWeight));
        }

        // [核心逻辑] 计算用于 MIX_IN 按比例计算的总面粉量
        // 注意：这里的总面粉量是考虑了损耗之后的“投入量”，确保计算 MIX_IN 原料时也间接考虑了主面团的损耗
        let totalFlourInputWeight = new Prisma.Decimal(0);
        const ingredientIds = Array.from(flattenedIngredients.keys());
        if (ingredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
            const ingredientMap = new Map(ingredients.map((i) => [i.id, i]));

            for (const [id, weight] of flattenedIngredients.entries()) {
                const ingredientInfo = ingredientMap.get(id);
                if (ingredientInfo?.isFlour) {
                    totalFlourInputWeight = totalFlourInputWeight.add(weight);
                }
            }
        }

        // 处理产品特有的附加原料（搅拌、馅料、装饰）
        for (const pIng of product.ingredients || []) {
            let requiredOutputWeight = new Prisma.Decimal(0); // 同样，先确定附加原料的“目标产出净重”
            if (pIng.weightInGrams) {
                requiredOutputWeight = new Prisma.Decimal(pIng.weightInGrams); // 固定克重
            } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                requiredOutputWeight = totalFlourInputWeight.mul(new Prisma.Decimal(pIng.ratio)); // 按总面粉投入量比例计算
            }

            if (requiredOutputWeight.isZero() || requiredOutputWeight.isNegative()) continue;

            // 如果附加原料本身也是一个配方（如卡仕达酱），则递归计算其原料用量
            if (pIng.linkedExtra) {
                const extraComponent = pIng.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    processComponentRecursively(
                        extraComponent as FullRecipeVersion['components'][0],
                        requiredOutputWeight,
                    );
                }
            } else if (pIng.ingredientId) {
                // 如果是基础原料，直接累加
                // 注意：这里我们假设附加的基础原料（如杏仁片）自身损耗为0，所以投入=产出
                const currentWeight = flattenedIngredients.get(pIng.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(pIng.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

        return flattenedIngredients;
    }

    /**
     * [新增函数] 计算生产一个产品所需的**所有基础原料的理论净重** (不含损耗)。
     * 用于理论成本核算、任务完成后的库存核销等需要知道“我应该消耗多少料”的场景。
     * @param product 完整的产品对象
     * @returns Map<ingredientId, theoreticalWeight>
     */
    private async _getFlattenedIngredientsTheoretical(product: FullProduct): Promise<Map<string, Prisma.Decimal>> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();

        const processComponentRecursively = (
            component: FullRecipeVersion['components'][0],
            requiredOutputWeight: Prisma.Decimal,
        ) => {
            // [核心区别] 理论计算，不考虑损耗率，直接使用 requiredOutputWeight 作为 totalInputWeight
            const totalInputWeight = requiredOutputWeight;

            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );
            if (totalRatio.isZero()) return;

            const weightPerRatioPoint = totalInputWeight.div(totalRatio);

            for (const ing of component.ingredients) {
                const ingredientInputWeight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                if (ing.linkedPreDough) {
                    const preDoughComponent = ing.linkedPreDough.versions?.[0]?.components?.[0];
                    if (preDoughComponent) {
                        processComponentRecursively(
                            preDoughComponent as FullRecipeVersion['components'][0],
                            ingredientInputWeight,
                        );
                    }
                } else if (ing.ingredientId) {
                    const currentWeight = flattenedIngredients.get(ing.ingredientId) || new Prisma.Decimal(0);
                    flattenedIngredients.set(ing.ingredientId, currentWeight.add(ingredientInputWeight));
                }
            }
        };

        const mainComponent = product.recipeVersion.components[0];
        if (mainComponent) {
            processComponentRecursively(mainComponent, new Prisma.Decimal(product.baseDoughWeight));
        }

        let totalFlourInputWeight = new Prisma.Decimal(0);
        const ingredientIds = Array.from(flattenedIngredients.keys());
        if (ingredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
            const ingredientMap = new Map(ingredients.map((i) => [i.id, i]));

            for (const [id, weight] of flattenedIngredients.entries()) {
                const ingredientInfo = ingredientMap.get(id);
                if (ingredientInfo?.isFlour) {
                    totalFlourInputWeight = totalFlourInputWeight.add(weight);
                }
            }
        }

        for (const pIng of product.ingredients || []) {
            let requiredOutputWeight = new Prisma.Decimal(0);
            if (pIng.weightInGrams) {
                requiredOutputWeight = new Prisma.Decimal(pIng.weightInGrams);
            } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                requiredOutputWeight = totalFlourInputWeight.mul(new Prisma.Decimal(pIng.ratio));
            }

            if (requiredOutputWeight.isZero() || requiredOutputWeight.isNegative()) continue;

            if (pIng.linkedExtra) {
                const extraComponent = pIng.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    processComponentRecursively(
                        extraComponent as FullRecipeVersion['components'][0],
                        requiredOutputWeight,
                    );
                }
            } else if (pIng.ingredientId) {
                const currentWeight = flattenedIngredients.get(pIng.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(pIng.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

        return flattenedIngredients;
    }

    /**
     * 计算生产指定数量产品所需的**总投入原料**清单 (含损耗)。
     * 用于【生产任务】和【备料清单】。
     */
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
            const totalConsumed = (flatIngredients.get(ingredient.id) || new Prisma.Decimal(0)).mul(quantity);
            if (totalConsumed.gt(0)) {
                result.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    activeSkuId: ingredient.activeSkuId,
                    totalConsumed: totalConsumed.toNumber(),
                });
            }
        }

        return result;
    }

    /**
     * [新增函数] 计算生产指定数量产品的**理论原料消耗**清单 (不含损耗)。
     * 用于【任务完成】时的库存核销。
     */
    async calculateTheoreticalProductConsumptions(
        tenantId: string,
        productId: string,
        quantity: number,
    ): Promise<ConsumptionDetail[]> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品不存在');
        }

        const flatIngredients = await this._getFlattenedIngredientsTheoretical(product);
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
            const totalConsumed = (flatIngredients.get(ingredient.id) || new Prisma.Decimal(0)).mul(quantity);
            if (totalConsumed.gt(0)) {
                result.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    activeSkuId: ingredient.activeSkuId,
                    totalConsumed: totalConsumed.toNumber(),
                });
            }
        }

        return result;
    }

    private async _getPricePerGramMap(tenantId: string, ingredientIds: string[]): Promise<Map<string, Prisma.Decimal>> {
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                type: true,
                currentStockInGrams: true,
                currentStockValue: true,
                activeSkuId: true,
            },
        });

        const priceMap = new Map<string, Prisma.Decimal>();
        const nonInventoriedIngredients = ingredients.filter((i) => i.type === IngredientType.NON_INVENTORIED);

        if (nonInventoriedIngredients.length > 0) {
            const activeSkuIds = nonInventoriedIngredients.map((i) => i.activeSkuId).filter(Boolean) as string[];

            if (activeSkuIds.length > 0) {
                const latestProcurements: {
                    skuId: string;
                    pricePerPackage: Prisma.Decimal;
                    specWeightInGrams: Prisma.Decimal;
                }[] = await this.prisma.$queryRaw`
                    SELECT p."skuId", p."pricePerPackage", s."specWeightInGrams"
                    FROM "ProcurementRecord" p
                    INNER JOIN "IngredientSKU" s ON p."skuId" = s.id
                    INNER JOIN (
                        SELECT "skuId", MAX("purchaseDate") as max_date
                        FROM "ProcurementRecord"
                        WHERE "skuId" IN (${Prisma.join(activeSkuIds)})
                        GROUP BY "skuId"
                    ) lp ON p."skuId" = lp."skuId" AND p."purchaseDate" = lp.max_date
                `;

                const latestPriceMap = new Map(latestProcurements.map((p) => [p.skuId, p]));
                for (const ingredient of nonInventoriedIngredients) {
                    const procurement = latestPriceMap.get(ingredient.activeSkuId || '');
                    if (procurement && new Prisma.Decimal(procurement.specWeightInGrams).gt(0)) {
                        const pricePerGram = new Prisma.Decimal(procurement.pricePerPackage).div(
                            procurement.specWeightInGrams,
                        );
                        priceMap.set(ingredient.id, pricePerGram);
                    } else {
                        priceMap.set(ingredient.id, new Prisma.Decimal(0));
                    }
                }
            }
        }

        for (const ingredient of ingredients) {
            if (priceMap.has(ingredient.id)) {
                continue;
            }

            switch (ingredient.type) {
                case IngredientType.STANDARD: {
                    const stockInGrams = new Prisma.Decimal(ingredient.currentStockInGrams);
                    const stockValue = new Prisma.Decimal(ingredient.currentStockValue);
                    if (stockInGrams.gt(0) && stockValue.gt(0)) {
                        const pricePerGram = stockValue.div(stockInGrams);
                        priceMap.set(ingredient.id, pricePerGram);
                    } else {
                        priceMap.set(ingredient.id, new Prisma.Decimal(0));
                    }
                    break;
                }
                case IngredientType.UNTRACKED: {
                    priceMap.set(ingredient.id, new Prisma.Decimal(0));
                    break;
                }
                default:
                    priceMap.set(ingredient.id, new Prisma.Decimal(0));
                    break;
            }
        }

        return priceMap;
    }
}
