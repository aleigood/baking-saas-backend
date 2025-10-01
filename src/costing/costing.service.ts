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
    totalWeight: number; // 含义：原料投料总重 (Input)
    targetWeight?: number; // [修改] 变为可选字段，仅在有损耗时提供
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
        totalWeight: number, // 传入的参数是“目标产出重量”
    ): Promise<CalculatedRecipeDetails> {
        const outputWeightTarget = totalWeight;

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

        const lossRatio = new Prisma.Decimal(mainComponent.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);

        const adjustedTotalWeight = divisor.isZero()
            ? new Prisma.Decimal(outputWeightTarget)
            : new Prisma.Decimal(outputWeightTarget).div(divisor);

        const totalRatio = mainComponent.ingredients.reduce(
            (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
            new Prisma.Decimal(0),
        );

        if (totalRatio.isZero()) {
            // 如果没有原料，则直接返回，totalWeight 等于目标重量
            return {
                id: recipeFamily.id,
                name: recipeFamily.name,
                type: recipeFamily.type,
                totalWeight: outputWeightTarget,
                procedure: mainComponent.procedure,
                ingredients: [],
            };
        }

        const weightPerRatioPoint = adjustedTotalWeight.div(totalRatio);

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

        const finalInputWeight = adjustedTotalWeight.toDP(1).toNumber();
        const finalOutputWeight = new Prisma.Decimal(outputWeightTarget).toDP(1).toNumber();

        // [核心修改] 构建基础返回对象
        const response: CalculatedRecipeDetails = {
            id: recipeFamily.id,
            name: recipeFamily.name,
            type: recipeFamily.type,
            totalWeight: finalInputWeight,
            procedure: mainComponent.procedure,
            ingredients: calculatedIngredients,
        };

        // [核心修改] 只有当两个重量不相等（即有损耗）时，才添加 targetWeight 字段
        if (finalInputWeight !== finalOutputWeight) {
            response.targetWeight = finalOutputWeight;
        }

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

    private _calculateTrueHydration(product: FullProduct): Prisma.Decimal {
        const flattenedIngredients = new Map<string, { weight: Prisma.Decimal; ingredient: Ingredient }>();

        const processComponent = (component: FullRecipeVersion['components'][0], flourWeightRef: Prisma.Decimal) => {
            for (const ing of component.ingredients) {
                if (ing.linkedPreDough && ing.flourRatio) {
                    const preDough = ing.linkedPreDough.versions?.[0]?.components?.[0];
                    if (preDough) {
                        const flourForPreDough = flourWeightRef.mul(new Prisma.Decimal(ing.flourRatio));
                        processComponent(preDough as FullRecipeVersion['components'][0], flourForPreDough);
                    }
                } else if (ing.ingredient && ing.ratio) {
                    const ingredientWeight = flourWeightRef.mul(new Prisma.Decimal(ing.ratio));
                    const current = flattenedIngredients.get(ing.ingredient.id);
                    if (current) {
                        current.weight = current.weight.add(ingredientWeight);
                    } else {
                        flattenedIngredients.set(ing.ingredient.id, {
                            weight: ingredientWeight,
                            ingredient: ing.ingredient,
                        });
                    }
                }
            }
        };

        const baseComponent = product.recipeVersion.components[0];
        if (!baseComponent) return new Prisma.Decimal(0);

        const baseComponentLossRatio = new Prisma.Decimal(baseComponent.lossRatio || 0);
        const baseComponentDivisor = new Prisma.Decimal(1).sub(baseComponentLossRatio);
        const adjustedBaseComponentWeight = !baseComponentDivisor.isZero()
            ? new Prisma.Decimal(product.baseDoughWeight).div(baseComponentDivisor)
            : new Prisma.Decimal(0);

        const calculateTotalRatio = (component: FullRecipeVersion['components'][0]): Prisma.Decimal => {
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

        const baseComponentTotalRatio = calculateTotalRatio(baseComponent);
        const flourWeightReference = !baseComponentTotalRatio.isZero()
            ? adjustedBaseComponentWeight.div(baseComponentTotalRatio)
            : new Prisma.Decimal(0);

        processComponent(baseComponent, flourWeightReference);

        let totalFlourWeight = new Prisma.Decimal(0);
        let totalWaterWeight = new Prisma.Decimal(0);

        for (const data of flattenedIngredients.values()) {
            if (data.ingredient.isFlour) {
                totalFlourWeight = totalFlourWeight.add(data.weight);
            }
            if (data.ingredient.waterContent.gt(0)) {
                const waterInIngredient = data.weight.mul(new Prisma.Decimal(data.ingredient.waterContent));
                totalWaterWeight = totalWaterWeight.add(waterInIngredient);
            }
        }

        if (totalFlourWeight.isZero()) {
            return new Prisma.Decimal(0);
        }

        return totalWaterWeight.div(totalFlourWeight);
    }

    private _parseProcedureForNotes(
        procedure: string[] | undefined | null,
        ingredientNotes: Map<string, string>,
    ): string[] {
        if (!procedure) {
            return [];
        }
        const noteRegex = /@(?:\[)?(.*?)(?:\])?[(（](.*?)[)）]/g;

        const cleanedProcedure = procedure
            .map((step) => {
                const stepMatches = [...step.matchAll(noteRegex)];
                for (const match of stepMatches) {
                    const [, ingredientName, note] = match;
                    if (ingredientName && note) {
                        ingredientNotes.set(ingredientName.trim(), note.trim());
                    }
                }

                const cleanedStep = step.replace(noteRegex, '').trim();

                if (cleanedStep === '') {
                    return null;
                }

                return cleanedStep;
            })
            .filter((step): step is string => step !== null);

        return cleanedProcedure;
    }

    async getCalculatedProductDetails(tenantId: string, productId: string): Promise<CalculatedProductCostDetails> {
        const product = await this.getFullProduct(tenantId, productId);
        if (!product) {
            throw new NotFoundException('产品或其激活的配方版本不存在');
        }

        const trueHydration = this._calculateTrueHydration(product);

        const flatIngredients = await this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        const pricePerGramMap = await this._getWeightedAveragePricePerGramMap(tenantId, ingredientIds);

        const getPricePerKg = (id: string) => {
            const pricePerGram = pricePerGramMap.get(id);
            return pricePerGram ? pricePerGram.mul(1000).toDP(2).toNumber() : 0;
        };

        const componentGroups: CalculatedComponentGroup[] = [];
        let totalCost = new Prisma.Decimal(0);

        const allIngredientsMeta = await this.prisma.ingredient.findMany({
            where: { id: { in: ingredientIds } },
            select: { id: true, isFlour: true },
        });
        const ingredientsMetaMap = new Map(allIngredientsMeta.map((i) => [i.id, i]));

        let trueTotalFlourWeight = new Prisma.Decimal(0);
        for (const [id, weight] of flatIngredients.entries()) {
            if (ingredientsMetaMap.get(id)?.isFlour) {
                trueTotalFlourWeight = trueTotalFlourWeight.add(weight);
            }
        }

        const processComponent = (
            component: FullRecipeVersion['components'][0],
            componentWeight: Prisma.Decimal,
            parentConversionFactor: Prisma.Decimal,
            isBaseComponent: boolean,
            flourWeightReference: Prisma.Decimal,
        ): CalculatedComponentGroup => {
            const ingredientNotes = new Map<string, string>();
            const cleanedProcedure = this._parseProcedureForNotes(component.procedure, ingredientNotes);

            const group: CalculatedComponentGroup = {
                name: isBaseComponent ? '基础组件' : component.name,
                ingredients: [],
                procedure: cleanedProcedure,
                totalCost: 0,
            };

            const lossRatio = new Prisma.Decimal(component.lossRatio || 0);
            const divisor = new Prisma.Decimal(1).sub(lossRatio);
            if (divisor.isZero() || divisor.isNegative()) {
                return group;
            }
            const adjustedComponentWeight = componentWeight.div(divisor);

            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );

            if (totalRatio.isZero() && !isBaseComponent) return group;

            const currentFlourWeight = isBaseComponent ? flourWeightReference : adjustedComponentWeight.div(totalRatio);

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

                    if (
                        isBaseComponent &&
                        ingredient.ingredient.name === '水' &&
                        product.recipeVersion.family.category === RecipeCategory.BREAD
                    ) {
                        const waterNote = `总水量: ${trueHydration.mul(100).toDP(1).toNumber()}%`;
                        extraInfoParts.push(waterNote);
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
        const baseComponentLossRatio = new Prisma.Decimal(baseComponent.lossRatio || 0);
        const baseComponentDivisor = new Prisma.Decimal(1).sub(baseComponentLossRatio);
        const adjustedBaseComponentWeight = !baseComponentDivisor.isZero()
            ? new Prisma.Decimal(product.baseDoughWeight).div(baseComponentDivisor)
            : new Prisma.Decimal(0);

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
                finalWeightInGrams = trueTotalFlourWeight.mul(new Prisma.Decimal(ing.ratio));
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
        // [核心修改] 扩展 Prisma 查询，使其能够深入查询 linkedExtra (附加项) 的完整配方信息，以便进行损耗计算
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

    private async _getFlattenedIngredients(product: FullProduct): Promise<Map<string, Prisma.Decimal>> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();

        const processComponentRecursively = (
            component: FullRecipeVersion['components'][0],
            requiredOutputWeight: Prisma.Decimal,
        ) => {
            const lossRatio = new Prisma.Decimal(component.lossRatio || 0);
            const divisor = new Prisma.Decimal(1).sub(lossRatio);
            if (divisor.isZero() || divisor.isNegative()) return;
            const totalInputWeight = requiredOutputWeight.div(divisor);

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

        let totalFlourWeight = new Prisma.Decimal(0);
        const ingredientIds = Array.from(flattenedIngredients.keys());
        if (ingredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({ where: { id: { in: ingredientIds } } });
            const ingredientMap = new Map(ingredients.map((i) => [i.id, i]));

            for (const [id, weight] of flattenedIngredients.entries()) {
                const ingredientInfo = ingredientMap.get(id);
                if (ingredientInfo?.isFlour) {
                    totalFlourWeight = totalFlourWeight.add(weight);
                }
            }
        }

        // [核心修改] 迭代产品的附加原料，并处理其损耗
        for (const pIng of product.ingredients || []) {
            let requiredOutputWeight = new Prisma.Decimal(0);
            if (pIng.weightInGrams) {
                requiredOutputWeight = new Prisma.Decimal(pIng.weightInGrams);
            } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                requiredOutputWeight = totalFlourWeight.mul(new Prisma.Decimal(pIng.ratio));
            }

            if (requiredOutputWeight.isZero() || requiredOutputWeight.isNegative()) continue;

            if (pIng.linkedExtra) {
                // [核心修改] 如果附加项是另一个配方 (如卡仕达酱)，则递归处理它
                const extraComponent = pIng.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    processComponentRecursively(
                        extraComponent as FullRecipeVersion['components'][0],
                        requiredOutputWeight,
                    );
                }
            } else if (pIng.ingredientId) {
                // 如果附加项是普通原料，则直接累加
                const currentWeight = flattenedIngredients.get(pIng.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(pIng.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

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
            const stockInGrams = new Prisma.Decimal(ingredient.currentStockInGrams);
            const stockValue = new Prisma.Decimal(ingredient.currentStockValue);

            if (stockInGrams.gt(0) && stockValue.gt(0)) {
                const pricePerGram = stockValue.div(stockInGrams);
                priceMap.set(ingredient.id, pricePerGram);
            } else {
                priceMap.set(ingredient.id, new Prisma.Decimal(0));
            }
        }

        return priceMap;
    }
}
