// G-Code-Note: Service (NestJS)
// 路径: src/costing/costing.service.ts
// [核心重构] 完整文件，以支持新 schema (preDoughId/extraId) 并修复 isRecipe 字段
// [G-Code-Note] [核心修复] 修复了 TS2551, TS2304, 和 no-unused-vars 错误

// [G-Code-Note] [核心重构] 导入在 "批量组装" 策略中需要用到的类型
import {
    Injectable,
    NotFoundException,
    // [G-Code-Note] 导入 Prisma 类型
} from '@nestjs/common';
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

// [核心修改] 增加 isRecipe
export interface CalculatedIngredientInfo {
    name: string;
    ratio: number;
    weightInGrams: number;
    pricePerKg: number;
    cost: number;
    extraInfo?: string;
    isRecipe: boolean; // [G-Code-Note] 修复问题3：添加 isRecipe
}

// [核心新增] 定义用于排序的类型
type SortableCalculatedIngredient = CalculatedIngredientInfo & { isFlour?: boolean };

export interface CalculatedComponentGroup {
    name: string;
    ingredients: SortableCalculatedIngredient[]; // [核心修改] 允许 ingredients 包含 isFlour
    procedure?: string[];
    totalCost: number;
}

// [核心修改] 增加 isRecipe
export interface CalculatedExtraIngredientInfo {
    id: string;
    name: string;
    type: string;
    cost: number;
    weightInGrams: number;
    ratio?: number;
    extraInfo?: string;
    isRecipe: boolean; // [G-Code-Note] 修复问题3：添加 isRecipe
}

export interface CalculatedProductCostDetails {
    totalCost: number;
    componentGroups: CalculatedComponentGroup[];
    extraIngredients: CalculatedExtraIngredientInfo[];
    groupedExtraIngredients: Record<string, CalculatedExtraIngredientInfo[]>;
    productProcedure: string[];
}

export interface CalculatedRecipeIngredient {
    ingredientId: string; // [核心修改] 确保有 ingredientId
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

// [G-Code-Note] [核心新增] 修复 TS2304
interface ConsumptionDetail {
    ingredientId: string;
    ingredientName: string;
    activeSkuId: string | null;
    totalConsumed: number;
}

// [G-Code-Note] [核心重构] 深入定义类型以支持递归查询 (支持新 schema)
// [G-Code-Note] 这个类型现在描述的是 "组装后" 的对象结构
type FullComponentIngredient = ComponentIngredient & {
    ingredient: Ingredient | null;
    linkedPreDough: // 面种
    | (RecipeFamily & {
              versions: (RecipeVersion & {
                  components: (RecipeComponent & {
                      ingredients: (ComponentIngredient & {
                          ingredient: Ingredient | null;
                          // [G-Code-Note] 开始嵌套
                          linkedPreDough: RecipeFamily | null;
                          linkedExtra: RecipeFamily | null;
                      })[];
                  })[];
              })[];
          })
        | null;
    linkedExtra: // 馅料
    | (RecipeFamily & {
              versions: (RecipeVersion & {
                  components: (RecipeComponent & {
                      ingredients: (ComponentIngredient & {
                          ingredient: Ingredient | null;
                          // [G-Code-Note] 开始嵌套
                          linkedPreDough: RecipeFamily | null;
                          linkedExtra: RecipeFamily | null;
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
    linkedExtra: // 产品中的馅料/装饰
    | (RecipeFamily & {
              versions: (RecipeVersion & {
                  components: (RecipeComponent & {
                      ingredients: (ComponentIngredient & {
                          ingredient: Ingredient | null;
                          // [G-Code-Note] 开始嵌套
                          linkedPreDough: RecipeFamily | null;
                          linkedExtra: RecipeFamily | null;
                      })[];
                  })[];
              })[];
          })
        | null;
};

type FullProduct = Product & {
    recipeVersion: FullRecipeVersion & { family: RecipeFamily };
    ingredients: FullProductIngredient[];
};

// [核心新增] 为快照中的 RecipeFamily 定义一个最小类型 (基于 Prisma 生成的类型)
// 这有助于 getCalculatedRecipeDetailsFromSnapshot 的类型安全
type SnapshotRecipeFamily = {
    id: string;
    name: string;
    type: RecipeType;
    versions: {
        components: {
            lossRatio: number | string | null;
            procedure: string[];
            ingredients: {
                ratio: number | string | null;
                // [G-Code-Note] [核心重构] 快照中可能同时包含两者 (虽然逻辑上不应该)
                linkedPreDough: {
                    id: string;
                    name: string;
                } | null;
                linkedExtra: {
                    id: string;
                    name: string;
                } | null;
                ingredient: {
                    id: string;
                    name: string;
                    activeSku: {
                        brand: string | null;
                    } | null;
                } | null;
            }[];
        }[];
    }[];
};

// [G-Code-Note] [核心重构] 复制自 production-tasks.service.ts 的 "浅层 Include"
// 用于 "批量查询" 策略
const recipeVersionRecursiveBatchInclude = {
    family: {
        select: {
            id: true,
            name: true,
            type: true,
            category: true,
        },
    },
    components: {
        include: {
            ingredients: {
                include: {
                    ingredient: { include: { activeSku: true } },
                    linkedPreDough: {
                        select: {
                            id: true,
                            name: true,
                            type: true,
                            category: true,
                            versions: { where: { isActive: true }, select: { id: true } },
                        },
                    },
                    linkedExtra: {
                        select: {
                            id: true,
                            name: true,
                            type: true,
                            category: true,
                            versions: { where: { isActive: true }, select: { id: true } },
                        },
                    },
                },
            },
        },
    },
    products: {
        where: { deletedAt: null },
        include: {
            ingredients: {
                include: {
                    ingredient: { include: { activeSku: true } },
                    linkedExtra: {
                        select: {
                            id: true,
                            name: true,
                            type: true,
                            category: true,
                            versions: { where: { isActive: true }, select: { id: true } },
                        },
                    },
                },
            },
        },
    },
};
// [G-Code-Note] [核心重构] "浅层 Include" 的 TS 类型
type FetchedRecipeVersion = Prisma.RecipeVersionGetPayload<{
    include: typeof recipeVersionRecursiveBatchInclude;
}>;

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
                                        linkedExtra: true, // [G-Code-Note] [核心重构] 包含 linkedExtra
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
                        ingredientId: ing.linkedPreDough.id, // [核心修改]
                        name: ing.linkedPreDough.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: true,
                        brand: null,
                    };
                } else if (ing.linkedExtra) {
                    // [G-Code-Note] [核心重构] 增加 linkedExtra
                    return {
                        ingredientId: ing.linkedExtra.id,
                        name: ing.linkedExtra.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: true,
                        brand: null,
                    };
                } else if (ing.ingredient) {
                    return {
                        ingredientId: ing.ingredient.id, // [核心修改]
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

    /**
     * [核心新增] getCalculatedRecipeDetails 的快照版本
     * 此方法是同步的，因为它只处理已传入的快照对象，不执行任何 I/O
     */
    getCalculatedRecipeDetailsFromSnapshot(
        snapshotRecipeFamily: any, // 接收来自快照的 RecipeFamily 对象
        totalWeight: number, // 目标产出重量 (Output)
    ): CalculatedRecipeDetails {
        // [核心修正] 立即转换类型，以便后续安全访问
        const recipeFamily = snapshotRecipeFamily as SnapshotRecipeFamily;
        const outputWeightTarget = new Prisma.Decimal(totalWeight);

        // [核心修改] 不再查询数据库，而是直接访问对象
        if (!recipeFamily || !recipeFamily.versions[0]?.components[0]) {
            // [核心修正] 使用类型安全且经过可选链检查的 'recipeFamily' 变量
            return {
                id: recipeFamily?.id || 'unknown',
                name: recipeFamily?.name || '快照数据不完整',
                type: recipeFamily?.type || 'OTHER',
                totalWeight: totalWeight,
                targetWeight: totalWeight,
                procedure: [],
                ingredients: [],
            };
        }

        const activeVersion = recipeFamily.versions[0];
        const mainComponent = activeVersion.components[0];

        // [核心逻辑] 根据损耗率，从“目标产出重量”反推计算“所需投入原料总重”
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
                totalWeight: outputWeightTarget.toNumber(),
                targetWeight: outputWeightTarget.toNumber(),
                procedure: mainComponent.procedure,
                ingredients: [],
            };
        }

        const weightPerRatioPoint = requiredInputWeight.div(totalRatio);

        const calculatedIngredients = mainComponent.ingredients
            .map((ing) => {
                // [核心修改] 确保从快照中读取时转换为 Decimal
                const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                if (ing.linkedPreDough) {
                    return {
                        ingredientId: ing.linkedPreDough.id,
                        name: ing.linkedPreDough.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: true,
                        brand: null,
                    };
                } else if (ing.linkedExtra) {
                    // [G-Code-Note] [核心重构] 增加 linkedExtra
                    return {
                        ingredientId: ing.linkedExtra.id,
                        name: ing.linkedExtra.name,
                        weightInGrams: weight.toNumber(),
                        isRecipe: true,
                        brand: null,
                    };
                } else if (ing.ingredient) {
                    return {
                        ingredientId: ing.ingredient.id,
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

    // [核心新增] 排序辅助函数
    private _sortCalculatedIngredients(
        ingredients: SortableCalculatedIngredient[],
        category: RecipeCategory,
        type: RecipeType,
    ): SortableCalculatedIngredient[] {
        const isFlourSort = type === 'PRE_DOUGH' || category === 'BREAD';

        return ingredients.sort((a, b) => {
            // 在 cost service 中, 预制面团(isRecipe)不在 ingredients 数组中，
            // 它们是独立的 componentGroups, 所以不需要 isRecipe 排序

            // 1. 如果是面包或面种类，应用面粉优先规则
            if (isFlourSort) {
                const aIsFlour = a.isFlour ?? false;
                const bIsFlour = b.isFlour ?? false;

                if (aIsFlour && !bIsFlour) return -1;
                if (!aIsFlour && bIsFlour) return 1;
            }

            // 2. 按用量（克重）倒序
            const aWeight = a.weightInGrams ?? 0;
            const bWeight = b.weightInGrams ?? 0;
            return bWeight - aWeight;
        });
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

        // [核心新增] 获取品类和类型用于排序
        const recipeCategory = product.recipeVersion.family.category;
        const recipeType = product.recipeVersion.family.type;

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

                // [G-Code-Note] [核心重构] 检查这个“原料”是不是又是一个配方
                const linkedRecipe = ing.linkedPreDough || ing.linkedExtra; // [G-Code-Note] 检查两种
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
            // [核心新增] 传入分类用于排序
            category: RecipeCategory,
            type: RecipeType,
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

            // [G-Code-Note] [核心修复] flourRatio 不计入 totalRatio，因此 totalRatio 可能为 0
            // if (totalRatio.isZero() && !isBaseComponent) return group;

            // [G-Code-Note] [核心修复] 基础重量计算
            // 1. 如果是面粉基准 (BREAD or PRE_DOUGH)，使用 flourWeightReference
            // 2. 如果是非面粉基准 (PASTRY, DESSERT, EXTRA)，使用 componentWeight / totalRatio
            const isFlourBased = category === 'BREAD' || type === 'PRE_DOUGH';
            let currentFlourWeight = new Prisma.Decimal(0); // 面粉基准
            let weightPerRatioPoint = new Prisma.Decimal(0); // 常规比例基准

            if (isFlourBased) {
                currentFlourWeight = isBaseComponent ? flourWeightReference : componentWeight.div(totalRatio);
            } else {
                if (!totalRatio.isZero()) {
                    weightPerRatioPoint = componentWeight.div(totalRatio);
                }
            }

            // [G-Code-Note] [核心修复] 修复 TS2551
            const { cleanedProcedure, ingredientNotes } = this._parseProcedureForNotes(
                component.procedure,
                currentFlourWeight, // 百分比替换仍然使用面粉基准
            );
            group.procedure = cleanedProcedure;

            for (const ingredient of component.ingredients) {
                const preDough = ingredient.linkedPreDough?.versions?.[0];
                const extra = ingredient.linkedExtra?.versions?.[0]; // [G-Code-Note] [核心重构] 检查 Extra

                let weight: Prisma.Decimal;
                let cost = new Prisma.Decimal(0);
                let pricePerKg = 0;
                let effectiveRatio = new Prisma.Decimal(0);

                if (preDough && ingredient.flourRatio) {
                    // [G-Code-Note] 场景1: 引用 PRE_DOUGH (面种)
                    const preDoughRecipe = preDough.components[0];
                    const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                        (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                        new Prisma.Decimal(0),
                    );
                    const flourForPreDough = flourWeightReference.mul(new Prisma.Decimal(ingredient.flourRatio));
                    weight = flourForPreDough.mul(preDoughTotalRatio);

                    let newConversionFactor: Prisma.Decimal;
                    if (ingredient.flourRatio && new Prisma.Decimal(ingredient.flourRatio).gt(0)) {
                        newConversionFactor = parentConversionFactor.mul(new Prisma.Decimal(ingredient.flourRatio));
                    } else {
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
                        // [核心新增] 传递预制面团的分类和类型
                        ingredient.linkedPreDough!.category,
                        ingredient.linkedPreDough!.type,
                    );
                    preDoughGroup.name = `${ingredient.linkedPreDough?.name}`;
                    componentGroups.push(preDoughGroup);
                } else if (extra && ingredient.ratio) {
                    // [G-Code-Note] [核心重构] 场景2: 引用 EXTRA (馅料)
                    weight = isFlourBased
                        ? currentFlourWeight.mul(new Prisma.Decimal(ingredient.ratio)) // BREAD/PRE_DOUGH 引用 EXTRA
                        : weightPerRatioPoint.mul(new Prisma.Decimal(ingredient.ratio)); // EXTRA/OTHER 引用 EXTRA

                    const extraComponent = extra.components[0];
                    if (extraComponent) {
                        cost = getExtraRecipeCost(extraComponent as FullRecipeVersion['components'][0], weight);
                    }
                    effectiveRatio = new Prisma.Decimal(ingredient.ratio ?? 0).mul(parentConversionFactor);

                    group.ingredients.push({
                        name: ingredient.linkedExtra!.name,
                        ratio: effectiveRatio.toNumber(),
                        weightInGrams: weight.toNumber(),
                        pricePerKg: 0, // 这是一个配方，没有单价
                        cost: cost.toNumber(),
                        extraInfo: ingredientNotes.get(ingredient.linkedExtra!.name) || undefined,
                        isFlour: false,
                        isRecipe: true, // [G-Code-Note] 修复问题3
                    });
                    group.totalCost = new Prisma.Decimal(group.totalCost).add(cost).toNumber();
                } else if (ingredient.ingredient && ingredient.ratio) {
                    // [G-Code-Note] 场景3: 标准原料
                    weight = isFlourBased
                        ? currentFlourWeight.mul(new Prisma.Decimal(ingredient.ratio)) // BREAD/PRE_DOUGH
                        : weightPerRatioPoint.mul(new Prisma.Decimal(ingredient.ratio)); // EXTRA/OTHER

                    pricePerKg = getPricePerKg(ingredient.ingredient.id);
                    cost = new Prisma.Decimal(pricePerKg).div(1000).mul(weight);
                    effectiveRatio = new Prisma.Decimal(ingredient.ratio ?? 0).mul(parentConversionFactor);

                    const extraInfoParts: string[] = [];
                    // [G-Code-Note] [核心修复] 修复 TS2551 相关的 no-unsafe-call  和 no-unsafe-member-access
                    const procedureNote = ingredientNotes.get(ingredient.ingredient.name);
                    if (procedureNote) {
                        extraInfoParts.push(procedureNote);
                    }

                    group.ingredients.push({
                        name: ingredient.ingredient.name,
                        ratio: effectiveRatio.toNumber(),
                        weightInGrams: weight.toNumber(),
                        pricePerKg: pricePerKg,
                        cost: cost.toNumber(),
                        extraInfo: extraInfoParts.length > 0 ? extraInfoParts.join('\n') : undefined,
                        isFlour: ingredient.ingredient.isFlour, // [核心新增]
                        isRecipe: false, // [G-Code-Note] 修复问题3
                    });
                    group.totalCost = new Prisma.Decimal(group.totalCost).add(cost).toNumber();
                }
            }

            // [核心新增] 在返回组之前对其原料进行排序
            group.ingredients = this._sortCalculatedIngredients(group.ingredients, category, type);

            // [核心修正] 将这个组件的总成本累加到产品总成本
            totalCost = totalCost.add(group.totalCost);
            return group;
        };

        const baseComponent = product.recipeVersion.components[0];
        // [G-Code-Note] [核心修复] 移除未使用的变量 'calculateTotalRatioForMain'

        // [G-Code-Note] [核心修复] 面粉基准计算逻辑
        const calculateFlourWeightReference = (component: FullRecipeVersion['components'][0]): Prisma.Decimal => {
            // 1. 计算总的面粉比例 (来自面粉原料 + 来自面种的 flourRatio)
            const totalFlourRatio = component.ingredients.reduce((sum, i) => {
                if (i.flourRatio && i.linkedPreDough) {
                    return sum.add(new Prisma.Decimal(i.flourRatio));
                }
                if (i.ingredient?.isFlour) {
                    return sum.add(new Prisma.Decimal(i.ratio ?? 0));
                }
                return sum;
            }, new Prisma.Decimal(0));

            // 2. 如果没有面粉，基准为 0
            if (totalFlourRatio.isZero()) {
                return new Prisma.Decimal(0);
            }

            // 3. 计算所有 *非面粉* 和 *非面种* 原料的比例
            const otherRatio = component.ingredients.reduce((sum, i) => {
                if ((!i.ingredient?.isFlour && i.ratio) || i.linkedExtra) {
                    return sum.add(new Prisma.Decimal(i.ratio ?? 0));
                }
                return sum;
            }, new Prisma.Decimal(0));

            // 4. (总重 - 分割损耗) / (面粉总比 + 其他总比) = 面粉基准
            const netWeight = new Prisma.Decimal(product.baseDoughWeight);
            const totalRatioSum = totalFlourRatio.add(otherRatio);
            if (totalRatioSum.isZero()) {
                return new Prisma.Decimal(0);
            }
            return netWeight.div(totalRatioSum);
        };

        let flourWeightReference = new Prisma.Decimal(0);
        const adjustedBaseComponentWeight = new Prisma.Decimal(product.baseDoughWeight);

        if (recipeCategory === 'BREAD') {
            flourWeightReference = calculateFlourWeightReference(baseComponent);
        }

        const baseComponentGroup = processComponent(
            baseComponent,
            adjustedBaseComponentWeight,
            new Prisma.Decimal(1),
            true,
            flourWeightReference,
            recipeCategory, // [核心新增] 传入主配方的分类
            recipeType, // [核心新增] 传入主配方的类型
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
        const extraIngredients = (product.ingredients || [])
            .map((ing) => {
                const name = ing.ingredient?.name || ing.linkedExtra?.name || '未知';
                let finalWeightInGrams = new Prisma.Decimal(0);
                let cost = new Prisma.Decimal(0);
                let pricePerKg = 0; // 仅当是基础原料时有效
                let isRecipe = false; // [G-Code-Note] 修复问题3

                if (ing.type === 'MIX_IN' && ing.ratio) {
                    finalWeightInGrams = flourWeightReference.mul(new Prisma.Decimal(ing.ratio));
                } else if (ing.weightInGrams) {
                    finalWeightInGrams = new Prisma.Decimal(ing.weightInGrams);
                }

                if (ing.ingredientId) {
                    // 是基础原料
                    pricePerKg = getPricePerKg(ing.ingredientId);
                    cost = new Prisma.Decimal(pricePerKg).div(1000).mul(finalWeightInGrams);
                    isRecipe = false; // [G-Code-Note] 修复问题3
                } else if (ing.linkedExtraId) {
                    // 是配方 (linkedExtra)
                    isRecipe = true; // [G-Code-Note] 修复问题3
                    const extraComponent = ing.linkedExtra?.versions?.[0]?.components?.[0];
                    if (extraComponent) {
                        // 调用我们新增的辅助函数来计算这个配方的成本
                        cost = getExtraRecipeCost(
                            extraComponent as FullRecipeVersion['components'][0],
                            finalWeightInGrams,
                        );
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
                    isRecipe: isRecipe, // [G-Code-Note] 修复问题3
                    // pricePerKg: pricePerKg, // 这一行可以去掉，因为对于配方它是无效的
                };
            })
            // [核心新增] 按用量（克重）倒序排序附加原料
            .sort((a, b) => b.weightInGrams - a.weightInGrams);

        const summaryRowName = product.recipeVersion.family.category === RecipeCategory.BREAD ? '基础面团' : '基础原料';
        const allExtraIngredients: CalculatedExtraIngredientInfo[] = [
            {
                id: 'component-summary',
                name: summaryRowName,
                type: '原料',
                cost: componentGroups.reduce((sum, g) => sum + g.totalCost, 0),
                // [G-Code-Note] [核心修复] 由于 product 来自 JSON.parse, baseDoughWeight 不再是 Decimal 对象
                // 必须像 L907 和 L916 一样重新包装
                weightInGrams: new Prisma.Decimal(product.baseDoughWeight).toNumber(),
                isRecipe: false, // [G-Code-Note] 修复问题3
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

    // [G-Code-Note] [核心重构] 废弃原有的 "庞大 include" (L1101-L1212)
    // [G-Code-Note] 采用 "批量查询 + 内存组装" 策略，与 production-tasks.service 一致
    private async getFullProduct(tenantId: string, productId: string): Promise<FullProduct | null> {
        // 1. Query 1 (L1)：获取“浅层”的产品信息
        // 这是一个“浅层”查询，只为了拿到 L1/L2 ID 和组装所需的基础字段
        const shallowProductInclude = {
            recipeVersion: {
                select: {
                    id: true, // L1 RecipeVersion ID
                    family: true, // L1 Family (用于 tenantId 校验)
                },
            },
            ingredients: {
                // L2 (Product Ingredients)
                include: {
                    ingredient: { include: { activeSku: true } }, // 基础原料
                    linkedExtra: {
                        // 配方原料 (L2)
                        select: {
                            id: true,
                            name: true,
                            type: true,
                            category: true,
                            versions: { where: { isActive: true }, select: { id: true } }, // L2 ID
                        },
                    },
                },
            },
        };

        const product = await this.prisma.product.findFirst({
            where: {
                id: productId,
                recipeVersion: { family: { tenantId } },
                deletedAt: null, // 确保产品未被删除
            },
            include: shallowProductInclude,
        });

        if (!product) {
            // [G-Code-Note] 增加一个友好的错误提示
            const exists = await this.prisma.product.findUnique({ where: { id: productId } });
            if (!exists) {
                throw new NotFoundException(`产品 (ID: ${productId}) 不存在。`);
            }
            if (exists.deletedAt) {
                throw new NotFoundException(`产品 (ID: ${productId}) 已被删除。`);
            }
            // 剩下的情况是 tenantId 不匹配
            throw new NotFoundException(`无法访问产品 (ID: ${productId})，可能不属于该店铺或已被删除。`);
        }

        // 2. 初始化：收集所有 L1 和 L2 的 RecipeVersion ID
        const initialVersionIds = new Set<string>();
        if (product.recipeVersionId) {
            initialVersionIds.add(product.recipeVersionId);
        }
        for (const pIng of product.ingredients) {
            if (pIng.linkedExtra?.versions[0]?.id) {
                initialVersionIds.add(pIng.linkedExtra.versions[0].id);
            }
        }

        // 3. 调用“批量查询”
        const versionMap = await this._fetchRecursiveRecipeVersions(Array.from(initialVersionIds), this.prisma);

        // 4. “内存组装” (与 production-tasks.service.ts 相同的逻辑)
        const stitchedVersionsCache = new Map<string, FetchedRecipeVersion | null>();

        const stitchVersionTree = (versionId: string): FetchedRecipeVersion | null => {
            if (stitchedVersionsCache.has(versionId)) {
                return stitchedVersionsCache.get(versionId)!;
            }

            const versionData = versionMap.get(versionId);
            if (!versionData) {
                stitchedVersionsCache.set(versionId, null);
                return null;
            }

            // 深度复制，防止污染缓存
            const version = JSON.parse(JSON.stringify(versionData)) as FetchedRecipeVersion;
            stitchedVersionsCache.set(versionId, null); // 标记为正在处理 (防循环)

            // 4b. 递归组装 Components (linkedPreDough 和 linkedExtra)
            for (const component of version.components) {
                for (const ing of component.ingredients) {
                    const nextPreDoughId = ing.linkedPreDough?.versions[0]?.id;
                    if (nextPreDoughId) {
                        const stitchedSubVersion = stitchVersionTree(nextPreDoughId);
                        if (stitchedSubVersion) {
                            ing.linkedPreDough = {
                                ...ing.linkedPreDough,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }

                    const nextExtraId = ing.linkedExtra?.versions[0]?.id;
                    if (nextExtraId) {
                        const stitchedSubVersion = stitchVersionTree(nextExtraId);
                        if (stitchedSubVersion) {
                            ing.linkedExtra = {
                                ...ing.linkedExtra,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                }
            }

            // 4c. 递归组装 Products (linkedExtra) - (对于配方内部的产品)
            for (const p of version.products) {
                for (const pIng of p.ingredients) {
                    const nextVersionId = pIng.linkedExtra?.versions[0]?.id;
                    if (nextVersionId) {
                        const stitchedSubVersion = stitchVersionTree(nextVersionId);
                        if (stitchedSubVersion) {
                            pIng.linkedExtra = {
                                ...pIng.linkedExtra,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                }
            }

            stitchedVersionsCache.set(versionId, version); // 存入缓存
            return version;
        };

        // 5. 启动组装
        const assembledProduct = JSON.parse(JSON.stringify(product)) as typeof product;

        // 5a. 组装 L1 (Main Recipe)
        const topLevelVersionId = assembledProduct.recipeVersionId;
        const stitchedL1Version = stitchVersionTree(topLevelVersionId);
        if (stitchedL1Version) {
            // [G-Code-Note] 组装 recipeVersion 对象，使其匹配 FullProduct 类型
            assembledProduct.recipeVersion = {
                ...stitchedL1Version,
                // [G-Code-Note] [核心修复] 使用 "assembledProduct.recipeVersion.family" (L1222 抓取的完整 Family)
                // 替换 "stitchedL1Version.family" (L222 抓取的部分 family)
                family: assembledProduct.recipeVersion.family,
            } as FullRecipeVersion & { family: RecipeFamily };
        } else {
            // L1 组装失败，说明配方数据有问题
            throw new NotFoundException(
                `产品 (ID: ${productId}) 关联的配方版本 (ID: ${topLevelVersionId}) 丢失或数据不完整。`,
            );
        }

        // 5b. 组装 L2 (Product Ingredients)
        for (const pIng of assembledProduct.ingredients) {
            const l2VersionId = pIng.linkedExtra?.versions[0]?.id;
            if (l2VersionId) {
                const stitchedL2Version = stitchVersionTree(l2VersionId);
                if (stitchedL2Version) {
                    pIng.linkedExtra = {
                        ...pIng.linkedExtra,
                        ...stitchedL2Version.family,
                        versions: [stitchedL2Version],
                    } as unknown as FullProductIngredient['linkedExtra']; // [G-Code-Note] [核心修复] 添加 'unknown'
                }
            }
        }

        // 6. 返回组装好的对象，它现在符合 FullProduct 类型
        return assembledProduct as unknown as FullProduct;
    }

    /**
     * [核心新增] 辅助函数：从 FullProduct 对象中构建一个包含所有基础原料的 Map
     * [核心修改] 修改参数为 any，以便接收快照对象
     */
    private _buildIngredientMapFromProduct(product: any): Map<string, Ingredient> {
        const fullProduct = product as FullProduct; // 类型断言
        const map = new Map<string, Ingredient>();

        const processComponent = (component: FullRecipeVersion['components'][0]) => {
            if (!component) return; // [核心修复] 增加安全检查
            for (const ing of component.ingredients) {
                if (ing.ingredient) {
                    map.set(ing.ingredient.id, ing.ingredient);
                }
                // [G-Code-Note] [核心重构] 递归检查
                if (ing.linkedPreDough) {
                    ing.linkedPreDough.versions.forEach((v) =>
                        v.components.forEach((c) => processComponent(c as FullRecipeVersion['components'][0])),
                    );
                }
                if (ing.linkedExtra) {
                    ing.linkedExtra.versions.forEach((v) =>
                        v.components.forEach((c) => processComponent(c as FullRecipeVersion['components'][0])),
                    );
                }
            }
        };

        fullProduct.recipeVersion.components.forEach(processComponent);

        for (const pIng of fullProduct.ingredients) {
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

                // [G-Code-Note] [核心重构] 如果这个“原料”本身是另一个配方（如预制面种或馅料），则递归调用本函数
                const linkedRecipe = ing.linkedPreDough || ing.linkedExtra;
                if (linkedRecipe) {
                    const subComponent = linkedRecipe.versions?.[0]?.components?.[0];
                    if (subComponent) {
                        processComponentRecursively(
                            subComponent as FullRecipeVersion['components'][0],
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

        // [核心修复] 增加安全检查
        if (!component) return;
        const totalRatio = component.ingredients.reduce(
            (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
            new Prisma.Decimal(0),
        );
        if (totalRatio.isZero()) return;

        const weightPerRatioPoint = totalInputWeight.div(totalRatio);

        for (const ing of component.ingredients) {
            const ingredientInputWeight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

            // [G-Code-Note] [核心重构] 检查这个“原料”是不是又是一个配方
            const linkedRecipe = ing.linkedPreDough || ing.linkedExtra;
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
     * [核心修正] 移除 'async' 关键字，使其变为同步方法
     */
    calculateProductConsumptionsFromSnapshot(
        snapshotProduct: any, // 接收来自快照的 product 对象
        quantity: number,
    ): ConsumptionDetail[] {
        // [核心修正] 移除 Promise<>
        const product = snapshotProduct as FullProduct; // 类型断言

        // [核心修改] 调用重构后的同步函数
        const flatIngredients = this._getFlattenedIngredients(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        if (ingredientIds.length === 0) return [];

        // [核心修改] 不再查询数据库，改为从快照中构建原料信息
        const ingredientInfoMap = this._buildIngredientMapFromProduct(product);

        const result: ConsumptionDetail[] = [];
        for (const ingredientId of ingredientIds) {
            const totalConsumed = (flatIngredients.get(ingredientId) || new Prisma.Decimal(0)).mul(quantity);
            if (totalConsumed.gt(0)) {
                // [核心修改] 从快照构建的 map 中获取信息
                const info = ingredientInfoMap.get(ingredientId);
                result.push({
                    ingredientId: ingredientId,
                    ingredientName: info?.name || '未知原料', // [核心修改]
                    activeSkuId: info?.activeSkuId || null, // [核心修改]
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
     * [核心修正] 移除 'async' 关键字，使其变为同步方法
     */
    calculateTheoreticalProductConsumptionsFromSnapshot(
        snapshotProduct: any, // 接收来自快照的 product 对象
        quantity: number,
    ): ConsumptionDetail[] {
        // [核心修正] 移除 Promise<>
        const product = snapshotProduct as FullProduct; // 类型断言

        // [核心修改] 调用重构后的同步函数
        const flatIngredients = this._getFlattenedIngredientsTheoretical(product);
        const ingredientIds = Array.from(flatIngredients.keys());
        if (ingredientIds.length === 0) return [];

        // [核心修改] 不再查询数据库，改为从快照中构建原料信息
        const ingredientInfoMap = this._buildIngredientMapFromProduct(product);

        const result: ConsumptionDetail[] = [];
        for (const ingredientId of ingredientIds) {
            const totalConsumed = (flatIngredients.get(ingredientId) || new Prisma.Decimal(0)).mul(quantity);
            if (totalConsumed.gt(0)) {
                // [核心修改] 从快照构建的 map 中获取信息
                const info = ingredientInfoMap.get(ingredientId);
                result.push({
                    ingredientId: ingredientId,
                    ingredientName: info?.name || '未知原料', // [核心修改]
                    activeSkuId: info?.activeSkuId || null, // [核心修改]
                    totalConsumed: totalConsumed.toNumber(),
                });
            }
        }

        return result;
    }

    // [G-Code-Note] [核心重构] 复制自 production-tasks.service.ts (L386)
    // 采用 "批量查询" 策略，替换 "庞大 include"
    private async _fetchRecursiveRecipeVersions(
        initialVersionIds: string[],
        tx: Prisma.TransactionClient, // [G-Code-Note] 修正为接收 Prisma.TransactionClient 或 PrismaService
    ): Promise<Map<string, FetchedRecipeVersion>> {
        // 1. 初始化队列和“仓库”
        const versionsToFetch = new Set<string>(initialVersionIds);
        const versionsInQueue = [...initialVersionIds];
        const allFetchedVersions = new Map<string, FetchedRecipeVersion>();

        // 2. 启动循环
        while (versionsInQueue.length > 0) {
            const batchIds = [...new Set(versionsInQueue.splice(0))];

            // 3. 批量查询
            // [G-Code-Note] 修正：使用 tx (传入的 prisma 客户端)
            const results = await tx.recipeVersion.findMany({
                where: { id: { in: batchIds } },
                include: recipeVersionRecursiveBatchInclude,
            });

            // 4. 分析
            for (const version of results) {
                if (!allFetchedVersions.has(version.id)) {
                    allFetchedVersions.set(version.id, version);

                    // 4b. 深度优先：查找下一层的新ID
                    for (const component of version.components) {
                        for (const ing of component.ingredients) {
                            const nextPreDoughId = ing.linkedPreDough?.versions[0]?.id;
                            if (nextPreDoughId && !versionsToFetch.has(nextPreDoughId)) {
                                versionsToFetch.add(nextPreDoughId);
                                versionsInQueue.push(nextPreDoughId);
                            }
                            const nextExtraId = ing.linkedExtra?.versions[0]?.id;
                            if (nextExtraId && !versionsToFetch.has(nextExtraId)) {
                                versionsToFetch.add(nextExtraId);
                                versionsInQueue.push(nextExtraId);
                            }
                        }
                    }
                    for (const product of version.products) {
                        for (const pIng of product.ingredients) {
                            const nextVersionId = pIng.linkedExtra?.versions[0]?.id;
                            if (nextVersionId && !versionsToFetch.has(nextVersionId)) {
                                versionsToFetch.add(nextVersionId);
                                versionsInQueue.push(nextVersionId);
                            }
                        }
                    }
                }
            }
        }
        // 5. 循环结束，返回完整的“仓库”
        return allFetchedVersions;
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
