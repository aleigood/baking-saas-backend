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
    totalWeight: number;
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
            // [核心修复] 移除 .toDP()，返回完整精度的 number
            totalWeight: requiredInputWeight.toNumber(),
            targetWeight: outputWeightTarget.toNumber(),
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

        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
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
                cost: snapshotTotalCost.toNumber(), // [核心修复] 移除 .toDP()
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
                cost: costPerKg.toNumber(), // [核心修复] 移除 .toDP()
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
                    return `${calculatedWeight.toDP(1).toNumber()}克`; // 保留此处的 toDP(1) 以便在UI上显示
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

        // [核心修正] flatIngredients 和 pricePerGramMap 包含了*所有*基础原料 (包括馅料的)
        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getPricePerGramMap(tenantId, ingredientIds);

        const getPricePerKg = (id: string) => {
            const pricePerGram = pricePerGramMap.get(id);
            return pricePerGram ? pricePerGram.mul(1000).toNumber() : 0; // [核心修复] 移除 .toDP()
        };

        // [核心修正] 新增一个辅助函数，用于递归计算一个“附加配方”的总成本
        // 这个函数是 _flattenComponentTheoretical 逻辑的“成本计算”版本
        const getExtraRecipeCost = (
            component: FullRecipeVersion['components'][0],
            requiredOutputWeight: Prisma.Decimal,
        ): Prisma.Decimal => {
            let extraCost = new Prisma.Decimal(0);
            // 理论计算，不考虑损耗
            const totalInputWeight = requiredOutputWeight;

            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );
            if (totalRatio.isZero()) return extraCost;

            const weightPerRatioPoint = totalInputWeight.div(totalRatio);

            for (const ing of component.ingredients) {
                const ingredientInputWeight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                // 检查这个“原料”是不是又是一个配方
                const linkedRecipe = ing.linkedPreDough; // (在ProductIngredient中字段名叫linkedExtra,但在ComponentIngredient中叫linkedPreDough, 复用此逻辑)
                if (linkedRecipe) {
                    const subComponent = linkedRecipe.versions?.[0]?.components?.[0];
                    if (subComponent) {
                        extraCost = extraCost.add(
                            getExtraRecipeCost(
                                subComponent as FullRecipeVersion['components'][0],
                                ingredientInputWeight,
                            ),
                        );
                    }
                } else if (ing.ingredientId) {
                    // 是基础原料，从 pricePerGramMap 查找价格并计算成本
                    const pricePerGram = pricePerGramMap.get(ing.ingredientId);
                    if (pricePerGram) {
                        extraCost = extraCost.add(pricePerGram.mul(ingredientInputWeight));
                    }
                }
            }
            return extraCost;
        };

        const componentGroups: CalculatedComponentGroup[] = [];
        let totalCost = new Prisma.Decimal(0); // [核心修正] 这是总成本累加器

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
                        cost: cost.toNumber(), // [核心修复] 移除 .toDP()
                        extraInfo: extraInfoParts.length > 0 ? extraInfoParts.join('\n') : undefined,
                    });
                    group.totalCost = new Prisma.Decimal(group.totalCost).add(cost).toNumber();
                }
            }
            // [核心修正] 将这个组件的总成本累加到产品总成本
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

        // [核心修正] 此循环现在同时负责计算附加原料的成本，并累加到 totalCost
        const extraIngredients = (product.ingredients || []).map((ing) => {
            const name = ing.ingredient?.name || ing.linkedExtra?.name || '未知';
            let finalWeightInGrams = new Prisma.Decimal(0);
            let cost = new Prisma.Decimal(0);
            let pricePerKg = 0; // 仅当是基础原料时有效

            if (ing.type === 'MIX_IN' && ing.ratio) {
                finalWeightInGrams = flourWeightReference.mul(new Prisma.Decimal(ing.ratio));
            } else if (ing.weightInGrams) {
                finalWeightInGrams = new Prisma.Decimal(ing.weightInGrams);
            }

            if (ing.ingredientId) {
                // 是基础原料
                pricePerKg = getPricePerKg(ing.ingredientId);
                cost = new Prisma.Decimal(pricePerKg).div(1000).mul(finalWeightInGrams);
            } else if (ing.linkedExtraId) {
                // 是配方 (linkedExtra)
                const extraComponent = ing.linkedExtra?.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    // 调用我们新增的辅助函数来计算这个配方的成本
                    cost = getExtraRecipeCost(extraComponent as FullRecipeVersion['components'][0], finalWeightInGrams);
                }
            }

            // [核心修正] 将这个附加原料的成本累加到产品总成本
            totalCost = totalCost.add(cost);

            return {
                id: ing.id,
                name: name,
                type: getProductIngredientTypeName(ing.type),
                cost: cost.toNumber(), // [核心修复] 移除 .toDP()
                weightInGrams: finalWeightInGrams.toNumber(),
                ratio: ing.ratio ? ing.ratio.toNumber() : undefined,
                extraInfo: undefined,
                // pricePerKg: pricePerKg, // 这一行可以去掉，因为对于配方它是无效的
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

        // [核心修正] 返回正确的总成本
        return {
            totalCost: totalCost.toNumber(), // [核心修复] 移除 .toDP()
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

        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
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
            totalCost: totalCost.toNumber(), // [核心修复] 移除 .toDP()
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

        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
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
                    value: cost.toNumber(), // [核心修复] 移除 .toDP()
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
     * [核心新增] 辅助函数：从 FullProduct 对象中构建一个包含所有基础原料的 Map
     */
    private _buildIngredientMapFromProduct(product: FullProduct): Map<string, Ingredient> {
        const map = new Map<string, Ingredient>();

        const processComponent = (component: FullRecipeVersion['components'][0]) => {
            for (const ing of component.ingredients) {
                if (ing.ingredient) {
                    map.set(ing.ingredient.id, ing.ingredient);
                }
                if (ing.linkedPreDough) {
                    ing.linkedPreDough.versions.forEach((v) =>
                        v.components.forEach((c) => processComponent(c as FullRecipeVersion['components'][0])),
                    );
                }
            }
        };

        product.recipeVersion.components.forEach(processComponent);

        for (const pIng of product.ingredients) {
            if (pIng.ingredient) {
                map.set(pIng.ingredient.id, pIng.ingredient);
            }
            if (pIng.linkedExtra) {
                pIng.linkedExtra.versions.forEach((v) =>
                    v.components.forEach((c) => processComponent(c as FullRecipeVersion['components'][0])),
                );
            }
        }

        return map;
    }

    /**
     * [核心函数] 计算生产一个产品所需的**所有基础原料的总投入量** (含损耗)。
     * [核心重构] 此函数现在是同步的，并且完全依赖传入的 product 对象。
     * @param product 完整的产品对象 (来自快照或实时查询)
     * @returns Map<ingredientId, totalInputWeight>
     */
    private _getFlattenedIngredients(product: FullProduct): Map<string, Prisma.Decimal> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();
        // [核心新增] 从 product 对象中构建原料 map
        const ingredientMap = this._buildIngredientMapFromProduct(product);

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
            // [核心修改] 从主组件(mainComponent)获取单次分割损耗
            const divisionLoss = new Prisma.Decimal(mainComponent.divisionLoss || 0);

            // [核心修改] Product.baseDoughWeight 是最终产品需要的面团“净重”，
            // 在计算总投料时，需要先加上分割损耗，再进行后续计算。
            const requiredBaseDoughOutput = new Prisma.Decimal(product.baseDoughWeight).add(divisionLoss);
            processComponentRecursively(mainComponent, requiredBaseDoughOutput);
        }

        // [核心修正] 修复MIX_IN原料的损耗计算Bug
        // 步骤 1: 计算理论面粉重量 (不含损耗), 作为MIX_IN比例的基准
        const theoreticalIngredients = new Map<string, Prisma.Decimal>();
        this._flattenComponentTheoretical(
            mainComponent,
            new Prisma.Decimal(product.baseDoughWeight), // 使用理论面团净重
            theoreticalIngredients,
        );

        let theoreticalFlourWeight = new Prisma.Decimal(0);
        for (const [id, weight] of theoreticalIngredients.entries()) {
            const ingredientInfo = ingredientMap.get(id); // ingredientMap 来自 541行
            if (ingredientInfo?.isFlour) {
                theoreticalFlourWeight = theoreticalFlourWeight.add(weight);
            }
        }

        // 步骤 2: 获取主面团的损耗因子
        const lossRatio = new Prisma.Decimal(mainComponent.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);
        if (divisor.isZero() || divisor.isNegative()) return flattenedIngredients; // 安全检查

        const divisionLoss = new Prisma.Decimal(mainComponent.divisionLoss || 0);
        const divisionLossFactor = new Prisma.Decimal(product.baseDoughWeight).isZero()
            ? new Prisma.Decimal(1)
            : new Prisma.Decimal(product.baseDoughWeight).add(divisionLoss).div(product.baseDoughWeight);

        // 步骤 3: 遍历附加原料, 应用正确的损耗逻辑
        // [原 607-628 行的循环被替换]
        for (const pIng of product.ingredients || []) {
            let requiredInputWeight = new Prisma.Decimal(0); // 这是最终需要的 "投入量" (含损耗)

            if (pIng.weightInGrams) {
                // 类型为 FILLING 或 TOPPING, 使用固定克重
                // 理论重量 = 投入重量 (因为主面团损耗不适用于它们)
                requiredInputWeight = new Prisma.Decimal(pIng.weightInGrams);
            } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                // 类型为 MIX_IN, 按比例计算
                // 1. 计算理论重量 (基于理论面粉)
                const theoreticalWeight = theoreticalFlourWeight.mul(new Prisma.Decimal(pIng.ratio));
                // 2. 将主面团的损耗 (分割损耗 + 工艺损耗) 应用到理论重量上
                requiredInputWeight = theoreticalWeight.mul(divisionLossFactor).div(divisor);
            } else {
                continue; // 没有重量或比例, 跳过
            }

            if (requiredInputWeight.isZero() || requiredInputWeight.isNegative()) continue;

            // 步骤 4: 递归处理或累加
            if (pIng.linkedExtra) {
                // 如果附加原料是另一个配方 (如卡仕达酱)
                const extraComponent = pIng.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    // 递归调用, `requiredInputWeight` 成为子配方的 "目标产出"
                    processComponentRecursively(
                        extraComponent as FullRecipeVersion['components'][0],
                        requiredInputWeight,
                    );
                }
            } else if (pIng.ingredientId) {
                // 如果是基础原料 (如香草籽, 杏仁片)
                // 将计算出的 "投入量" 直接累加
                const currentWeight = flattenedIngredients.get(pIng.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(pIng.ingredientId, currentWeight.add(requiredInputWeight));
            }
        }

        return flattenedIngredients;
    }

    /**
     * [新增函数] 计算生产一个产品所需的**所有基础原料的理论净重** (不含损耗)。
     * [核心重构] 此函数现在是同步的，并且完全依赖传入的 product 对象。
     * @param product 完整的产品对象 (来自快照或实时查询)
     * @returns Map<ingredientId, theoreticalWeight>
     */
    private _getFlattenedIngredientsTheoretical(product: FullProduct): Map<string, Prisma.Decimal> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();
        // [核心新增] 从 product 对象中构建原料 map
        const ingredientMap = this._buildIngredientMapFromProduct(product);

        // [核心修正] 将递归逻辑提取到一个可复用的私有函数，并确保它能处理map的传递
        this._flattenComponentTheoretical(
            product.recipeVersion.components[0],
            new Prisma.Decimal(product.baseDoughWeight),
            flattenedIngredients,
        );

        // [核心重构] 不再查询数据库，而是使用 ingredientMap
        let totalFlourInputWeight = new Prisma.Decimal(0);
        for (const [id, weight] of flattenedIngredients.entries()) {
            const ingredientInfo = ingredientMap.get(id);
            if (ingredientInfo?.isFlour) {
                totalFlourInputWeight = totalFlourInputWeight.add(weight);
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
                    // [核心修正] 复用提取的私有函数
                    this._flattenComponentTheoretical(
                        extraComponent as FullRecipeVersion['components'][0],
                        requiredOutputWeight,
                        flattenedIngredients,
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
     * [核心修正] 提取 _getFlattenedIngredientsTheoretical 中的递归逻辑，使其可复用
     */
    private _flattenComponentTheoretical(
        component: FullRecipeVersion['components'][0],
        requiredOutputWeight: Prisma.Decimal,
        flattenedMap: Map<string, Prisma.Decimal>,
    ) {
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

            const linkedRecipe = ing.linkedPreDough; // (在ProductIngredient中字段名叫linkedExtra,但在ComponentIngredient中叫linkedPreDough, 复用此逻辑)
            if (linkedRecipe) {
                const subComponent = linkedRecipe.versions?.[0]?.components?.[0];
                if (subComponent) {
                    this._flattenComponentTheoretical(
                        subComponent as FullRecipeVersion['components'][0],
                        ingredientInputWeight,
                        flattenedMap,
                    );
                }
            } else if (ing.ingredientId) {
                const currentWeight = flattenedMap.get(ing.ingredientId) || new Prisma.Decimal(0);
                flattenedMap.set(ing.ingredientId, currentWeight.add(ingredientInputWeight));
            }
        }
    }

    /**
     * 计算生产指定数量产品所需的**总投入原料**清单 (含损耗)。
     * 用于【生产任务】和【备料清单】。(实时查询)
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

        // [核心修改] 调用重构后的同步函数
        const flatIngredients = this._getFlattenedIngredients(product);
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
     * [核心新增] 从“快照”计算生产指定数量产品所需的**总投入原料**清单 (含损耗)。
     */
    async calculateProductConsumptionsFromSnapshot(
        snapshotProduct: any, // 接收来自快照的 product 对象
        quantity: number,
    ): Promise<ConsumptionDetail[]> {
        const product = snapshotProduct as FullProduct; // 类型断言

        // [核心修改] 调用重构后的同步函数
        const flatIngredients = this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        if (ingredientIds.length === 0) return [];

        // [核心修改] 仍然需要查询“实时”的原料名称和SKU ID
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                name: true,
                activeSkuId: true,
            },
        });
        const ingredientInfoMap = new Map(ingredients.map((i) => [i.id, { name: i.name, activeSkuId: i.activeSkuId }]));

        const result: ConsumptionDetail[] = [];
        for (const ingredientId of ingredientIds) {
            const totalConsumed = (flatIngredients.get(ingredientId) || new Prisma.Decimal(0)).mul(quantity);
            if (totalConsumed.gt(0)) {
                const info = ingredientInfoMap.get(ingredientId);
                result.push({
                    ingredientId: ingredientId,
                    ingredientName: info?.name || '未知原料',
                    activeSkuId: info?.activeSkuId || null,
                    totalConsumed: totalConsumed.toNumber(),
                });
            }
        }

        return result;
    }

    /**
     * [新增函数] 计算生产指定数量产品的**理论原料消耗**清单 (不含损耗)。
     * 用于【任务完成】时的库存核销。(实时查询)
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

        // [核心修改] 调用重构后的同步函数
        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
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
     * [核心新增] 从“快照”计算生产指定数量产品的**理论原料消耗**清单 (不含损耗)。
     */
    async calculateTheoreticalProductConsumptionsFromSnapshot(
        snapshotProduct: any, // 接收来自快照的 product 对象
        quantity: number,
    ): Promise<ConsumptionDetail[]> {
        const product = snapshotProduct as FullProduct; // 类型断言

        // [核心修改] 调用重构后的同步函数
        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        if (ingredientIds.length === 0) return [];

        // [核心修改] 仍然需要查询“实时”的原料名称和SKU ID
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                name: true,
                activeSkuId: true,
            },
        });
        const ingredientInfoMap = new Map(ingredients.map((i) => [i.id, { name: i.name, activeSkuId: i.activeSkuId }]));

        const result: ConsumptionDetail[] = [];
        for (const ingredientId of ingredientIds) {
            const totalConsumed = (flatIngredients.get(ingredientId) || new Prisma.Decimal(0)).mul(quantity);
            if (totalConsumed.gt(0)) {
                const info = ingredientInfoMap.get(ingredientId);
                result.push({
                    ingredientId: ingredientId,
                    ingredientName: info?.name || '未知原料',
                    activeSkuId: info?.activeSkuId || null,
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

        // [核心修正] 确保所有请求的ID都有一个值，防止后续计算出错
        for (const id of ingredientIds) {
            if (!priceMap.has(id)) {
                priceMap.set(id, new Prisma.Decimal(0));
            }
        }

        return priceMap;
    }
}
