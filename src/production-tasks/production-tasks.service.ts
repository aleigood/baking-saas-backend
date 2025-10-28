import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import {
    IngredientType,
    Prisma,
    ProductIngredientType,
    ProductionTask,
    ProductionTaskStatus,
    RecipeCategory,
    RecipeFamily,
    RecipeType,
} from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService, CalculatedRecipeDetails } from '../costing/costing.service';
import { QueryTaskDetailDto } from './dto/query-task-detail.dto';
import {
    ComponentGroup,
    ProductComponentSummary,
    ProductDetails,
    TaskDetailResponseDto,
    TaskIngredientDetail,
} from './dto/task-detail.dto';
import { UpdateTaskDetailsDto } from './dto/update-task-details.dto';
import { BillOfMaterialsResponseDto, BillOfMaterialsItem, PrepTask } from './dto/preparation.dto';

const spoilageStages = [
    { key: 'kneading', label: '打面失败' },
    { key: 'fermentation', label: '发酵失败' },
    { key: 'shaping', label: '整形失败' },
    { key: 'baking', label: '烘烤失败' },
    { key: 'development', label: '新品研发' },
    { key: 'other', label: '其他原因' },
];

const taskWithDetailsInclude = {
    items: {
        include: {
            product: {
                include: {
                    recipeVersion: {
                        include: {
                            family: true,
                            components: {
                                include: {
                                    ingredients: {
                                        // L1
                                        include: {
                                            ingredient: { include: { activeSku: true } },
                                            linkedPreDough: {
                                                // L2
                                                include: {
                                                    versions: {
                                                        where: { isActive: true },
                                                        include: {
                                                            components: {
                                                                include: {
                                                                    ingredients: {
                                                                        // L3
                                                                        include: {
                                                                            ingredient: true,
                                                                            // [核心修改] 增加递归深度以匹配 resolveDependencies
                                                                            linkedPreDough: {
                                                                                // L4
                                                                                include: {
                                                                                    versions: {
                                                                                        where: { isActive: true },
                                                                                        include: {
                                                                                            components: {
                                                                                                include: {
                                                                                                    ingredients: {
                                                                                                        // L5
                                                                                                        include: {
                                                                                                            ingredient: true,
                                                                                                            linkedPreDough: true, // 停止在 L6
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
                            ingredient: { include: { activeSku: true } },
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
            },
        },
    },
    createdBy: {
        select: {
            name: true,
            phone: true,
        },
    },
};

const taskListItemsInclude = {
    items: {
        select: {
            quantity: true,
            product: {
                select: {
                    id: true,
                    name: true,
                },
            },
        },
    },
    createdBy: {
        select: {
            name: true,
            phone: true,
        },
    },
};

type TaskWithDetails = Prisma.ProductionTaskGetPayload<{
    include: typeof taskWithDetailsInclude;
}>;

type TaskItemWithDetails = TaskWithDetails['items'][0];
type ProductWithDetails = TaskItemWithDetails['product'];
type ComponentWithIngredients = ProductWithDetails['recipeVersion']['components'][0];
type ComponentWithRecursiveIngredients = ProductWithDetails['recipeVersion']['components'][0];

type PrepItemFamily = RecipeFamily;
type RequiredPrepItem = { family: PrepItemFamily; totalWeight: Prisma.Decimal };

type FlattenedIngredient = {
    id: string;
    name: string;
    weight: Prisma.Decimal;
    brand: string | null;
    isRecipe: boolean;
    recipeType?: RecipeType;
    recipeFamily?: PrepItemFamily;
    type?: ProductIngredientType;
    ratio?: Prisma.Decimal;
    weightInGrams?: Prisma.Decimal;
    waterContent?: Prisma.Decimal;
};

@Injectable()
export class ProductionTasksService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly costingService: CostingService,
    ) {}

    // [核心新增] 新增一个私有方法，用于获取并序列化任务的实时配方数据作为快照
    private async _fetchAndSerializeSnapshot(
        taskId: string,
        tx?: Prisma.TransactionClient,
    ): Promise<Prisma.JsonObject> {
        const prismaClient = tx || this.prisma;
        const task = await prismaClient.productionTask.findUnique({
            where: { id: taskId },
            include: taskWithDetailsInclude,
        });

        if (!task) {
            // 这个函数在内部调用，理论上不应该发生
            throw new NotFoundException('无法生成快照：任务未找到。');
        }

        // [核心修改] 修正快照逻辑，使其保存整个任务对象，并过滤掉已软删除的产品
        // 这与 findOne 中加载快照的逻辑 (as unknown as TaskWithDetails) 保持一致
        const snapshot = {
            ...task,
            items: task.items.filter((item) => !item.product.deletedAt),
        };

        return snapshot as unknown as Prisma.JsonObject;
    }

    private _sanitizeTask(task: TaskWithDetails) {
        return {
            ...task,
            items: task.items.map((item) => ({
                ...item,
                product: {
                    ...item.product,
                    baseDoughWeight: item.product.baseDoughWeight.toNumber(),
                    recipeVersion: {
                        ...item.product.recipeVersion,
                        components: item.product.recipeVersion.components.map((component) => ({
                            ...component,
                            targetTemp: component.targetTemp?.toNumber(),
                            lossRatio: component.lossRatio?.toNumber(),
                            divisionLoss: component.divisionLoss?.toNumber(),
                            ingredients: component.ingredients.map((ing) => ({
                                ...ing,
                                ratio: ing.ratio?.toNumber(),
                                flourRatio: ing.flourRatio?.toNumber(),
                                ingredient: ing.ingredient
                                    ? {
                                          ...ing.ingredient,
                                          waterContent: ing.ingredient.waterContent.toNumber(),
                                          currentStockInGrams: ing.ingredient.currentStockInGrams.toNumber(),
                                          currentStockValue: ing.ingredient.currentStockValue.toNumber(),
                                      }
                                    : null,
                            })),
                        })),
                    },
                    ingredients: item.product.ingredients.map((pIng) => ({
                        ...pIng,
                        ratio: pIng.ratio?.toNumber(),
                        weightInGrams: pIng.weightInGrams?.toNumber(),
                    })),
                },
            })),
        };
    }

    private _calculateWaterTemp(targetTemp: number, mixerType: number, flourTemp: number, ambientTemp: number): number {
        return (targetTemp - mixerType) * 3 - flourTemp - ambientTemp;
    }

    private _calculateIce(targetWaterTemp: number, totalWater: number, initialWaterTemp: number): number {
        if (targetWaterTemp >= initialWaterTemp) {
            return 0;
        }
        const ice = (totalWater * (initialWaterTemp - targetWaterTemp)) / (initialWaterTemp + 80);
        return ice;
    }

    private _calculateRequiredWetIngredientTemp(
        targetWaterTemp: number,
        totalRecipeWater: number,
        availableWaterToReplace: number,
    ): number {
        if (availableWaterToReplace - totalRecipeWater === 0) {
            return 0;
        }
        return (
            (-totalRecipeWater * targetWaterTemp - 80 * availableWaterToReplace) /
            (availableWaterToReplace - totalRecipeWater)
        );
    }

    async create(tenantId: string, userId: string, createProductionTaskDto: CreateProductionTaskDto) {
        const { startDate, endDate, notes, products } = createProductionTaskDto;

        if (!products || products.length === 0) {
            throw new BadRequestException('一个生产任务至少需要包含一个产品。');
        }

        const productIds = products.map((p) => p.productId);

        // [核心修改] 此处的检查是基于“实时”数据的，这是正确的，用于“规划时”检查
        const existingProducts = await this.prisma.product.findMany({
            where: {
                id: { in: productIds },
                recipeVersion: { family: { tenantId } },
                deletedAt: null, // [核心修改] 确保只查找未被软删除的产品
            },
            include: {
                recipeVersion: {
                    include: {
                        family: {
                            select: {
                                deletedAt: true,
                                name: true,
                                category: true,
                            },
                        },
                    },
                },
            },
        });

        if (existingProducts.length !== productIds.length) {
            throw new NotFoundException('一个或多个目标产品不存在或不属于该店铺。');
        }

        const discontinuedProducts = existingProducts.filter((p) => p.recipeVersion.family.deletedAt !== null);
        if (discontinuedProducts.length > 0) {
            const names = [...new Set(discontinuedProducts.map((p) => p.recipeVersion.family.name))].join('", "');
            throw new BadRequestException(`无法创建任务，因为配方 "${names}" 已被停用。`);
        }

        const firstCategory = existingProducts[0].recipeVersion.family.category;
        const allSameCategory = existingProducts.every((p) => p.recipeVersion.family.category === firstCategory);

        if (!allSameCategory) {
            throw new BadRequestException('一次生产任务只能包含同一品类的产品。');
        }

        // [核心修改] 库存检查同样基于“实时”数据，作为“规划时”的警告
        const allConsumptions = new Map<
            string,
            { ingredientId: string; ingredientName: string; totalConsumed: number }
        >();
        for (const item of products) {
            const fullProduct = await this.prisma.product.findUnique({
                where: { id: item.productId },
                include: taskWithDetailsInclude.items.include.product.include,
            });
            if (!fullProduct) continue;

            const consumptions = this._getFlattenedIngredientsForBOM(fullProduct as ProductWithDetails);
            for (const [ingredientId, weight] of consumptions.entries()) {
                const totalWeight = weight.mul(item.quantity);
                const existing = allConsumptions.get(ingredientId);
                if (existing) {
                    existing.totalConsumed += totalWeight.toNumber();
                } else {
                    const ingredientInfo = await this.prisma.ingredient.findUnique({ where: { id: ingredientId } });
                    allConsumptions.set(ingredientId, {
                        ingredientId: ingredientId,
                        ingredientName: ingredientInfo?.name || '未知原料',
                        totalConsumed: totalWeight.toNumber(),
                    });
                }
            }
        }
        const finalConsumptions = Array.from(allConsumptions.values());

        let stockWarning: string | null = null;
        if (finalConsumptions.length > 0) {
            const ingredientIds = finalConsumptions.map((c) => c.ingredientId);
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, type: true },
            });

            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);

            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];

            for (const consumption of finalConsumptions) {
                const ingredient = ingredientStockMap.get(consumption.ingredientId);
                if (ingredient && new Prisma.Decimal(ingredient.currentStockInGrams).lt(consumption.totalConsumed)) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }

        // [核心修改] 在事务中创建任务并立即生成快照
        const createdTask = await this.prisma.$transaction(async (tx) => {
            const task = await tx.productionTask.create({
                data: {
                    startDate,
                    endDate,
                    notes,
                    tenantId,
                    createdById: userId,
                    items: {
                        create: products.map((p) => ({
                            productId: p.productId,
                            quantity: p.quantity,
                        })),
                    },
                    // recipeSnapshot 暂时为 null
                },
            });

            // 立即获取快照
            const snapshot = await this._fetchAndSerializeSnapshot(task.id, tx);

            // 更新任务以包含快照
            const taskWithSnapshot = await tx.productionTask.update({
                where: { id: task.id },
                data: {
                    recipeSnapshot: snapshot,
                },
                include: taskWithDetailsInclude, // 确保返回的数据结构一致
            });

            return taskWithSnapshot;
        });

        return { task: this._sanitizeTask(createdTask), warning: stockWarning };
    }

    /**
     * [核心修改] 此方法现在基于“快照”计算预制件需求
     * 它接受一个 TaskWithDetails 对象（从快照中解析而来）
     */
    private async _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): Promise<CalculatedRecipeDetails[]> {
        if (!task || !task.items || task.items.length === 0) {
            return [];
        }

        const requiredPrepItems = new Map<string, RequiredPrepItem>();
        const visitedRecipes = new Set<string>();

        // [核心修改] 此函数现在依赖传入的 task (快照) 对象，而不是实时查询数据库
        const resolveDependencies = async (familyId: string, requiredWeight: Prisma.Decimal) => {
            if (visitedRecipes.has(familyId)) return;
            visitedRecipes.add(familyId);

            // [核心修改] 依赖 costingService 来获取快照中配方的信息
            // 注意：这暗含一个要求，即 costingService 必须能处理从快照中提取的配方数据
            // 为了简化，我们暂时假定快照中的 pre-dough 结构是完整的，可以用于遍历
            // 一个更健壮的实现可能需要 costingService 也能接收序列化的配方数据

            // 查找快照中所有产品，看谁依赖了这个 familyId
            // 这部分逻辑变得复杂，因为我们不能只依赖数据库
            // 我们将依赖快照中已拉取的 `linkedPreDough.versions` 数据
            const allPreDoughIngredients = task.items
                .flatMap((item) => item.product.recipeVersion?.components || [])
                .flatMap((comp) => comp.ingredients)
                .filter((ing) => ing.linkedPreDough?.id === familyId);

            const firstMatch = allPreDoughIngredients.length > 0 ? allPreDoughIngredients[0] : null;
            const preDoughFamily = firstMatch?.linkedPreDough;

            if (!preDoughFamily || !preDoughFamily.versions[0]?.components[0]) return;

            const activeVersion = preDoughFamily.versions[0];
            const mainComponent = activeVersion.components[0];

            const totalRatio = mainComponent.ingredients.reduce(
                (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
                new Prisma.Decimal(0),
            );

            if (totalRatio.isZero()) return;
            const weightPerRatioPoint = requiredWeight.div(totalRatio);

            for (const ing of mainComponent.ingredients) {
                const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                if (ing.linkedPreDough) {
                    const existing = requiredPrepItems.get(ing.linkedPreDough.id);
                    if (existing) {
                        existing.totalWeight = existing.totalWeight.add(weight);
                    } else {
                        requiredPrepItems.set(ing.linkedPreDough.id, {
                            family: ing.linkedPreDough as PrepItemFamily, // [修复] 类型断言
                            totalWeight: weight,
                        });
                    }
                    // [核心修改] 递归调用，但依赖于快照数据
                    await resolveDependencies(ing.linkedPreDough.id, weight);
                }
            }
        };

        for (const item of task.items) {
            const product = item.product;
            if (!product) continue;
            // [核心修改] 跳过已软删除的产品（快照中可能也包含此信息）
            if (product.deletedAt) continue;

            const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
            if (!product.recipeVersion) continue; // 安全检查

            for (const component of product.recipeVersion.components) {
                for (const ing of component.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                        if (preDoughRecipe) {
                            const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                                (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                                new Prisma.Decimal(0),
                            );
                            const weight = totalFlourWeight
                                .mul(new Prisma.Decimal(ing.flourRatio)) // [修复] 确保从快照加载时转换为Decimal
                                .mul(preDoughTotalRatio)
                                .mul(item.quantity);

                            const existing = requiredPrepItems.get(ing.linkedPreDough.id);
                            if (existing) {
                                existing.totalWeight = existing.totalWeight.add(weight);
                            } else {
                                requiredPrepItems.set(ing.linkedPreDough.id, {
                                    family: ing.linkedPreDough,
                                    totalWeight: weight,
                                });
                            }
                            await resolveDependencies(ing.linkedPreDough.id, weight);
                        }
                    }
                }
            }

            for (const pIng of product.ingredients) {
                if (pIng.linkedExtra) {
                    let weight = new Prisma.Decimal(0);
                    if (pIng.weightInGrams) {
                        weight = new Prisma.Decimal(pIng.weightInGrams).mul(item.quantity);
                    } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                        weight = totalFlourWeight.mul(new Prisma.Decimal(pIng.ratio)).mul(item.quantity); // [修复] 确保从快照加载时转换为Decimal
                    }
                    const existing = requiredPrepItems.get(pIng.linkedExtra.id);
                    if (existing) {
                        existing.totalWeight = existing.totalWeight.add(weight);
                    } else {
                        requiredPrepItems.set(pIng.linkedExtra.id, {
                            family: pIng.linkedExtra,
                            totalWeight: weight,
                        });
                    }
                    await resolveDependencies(pIng.linkedExtra.id, weight);
                }
            }
        }

        if (requiredPrepItems.size === 0) {
            return [];
        }

        const prepTaskItems: CalculatedRecipeDetails[] = [];
        for (const [id, data] of requiredPrepItems.entries()) {
            // [核心修改] 此处 costingService 仍然查询实时配方。
            // 这是一个权衡：我们假设预制件的“配方”是实时的，但“需求量”是基于快照计算的。
            // 理想情况下，costingService 也应能接收快照数据。
            const [details, recipeFamily] = await Promise.all([
                this.costingService.getCalculatedRecipeDetails(tenantId, id, data.totalWeight.toNumber()),
                this.prisma.recipeFamily.findUnique({
                    where: { id },
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
                }),
            ]);

            const mainComponent = recipeFamily?.versions[0]?.components[0];
            const procedure = mainComponent?.procedure;

            if (procedure && mainComponent && details.ingredients && details.ingredients.length > 0) {
                let baseForPercentageCalc = new Prisma.Decimal(data.totalWeight.toNumber());
                if (
                    (recipeFamily.type === RecipeType.PRE_DOUGH || recipeFamily.category === RecipeCategory.BREAD) &&
                    mainComponent.ingredients.length > 0
                ) {
                    const totalRatio = mainComponent.ingredients.reduce(
                        (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
                        new Prisma.Decimal(0),
                    );
                    if (!totalRatio.isZero()) {
                        baseForPercentageCalc = new Prisma.Decimal(data.totalWeight.toNumber()).div(totalRatio);
                    }
                }

                const { processedProcedure, ingredientNotes } = this._parseAndCalculateProcedureNotes(
                    procedure,
                    baseForPercentageCalc,
                );
                details.procedure = processedProcedure;

                if (ingredientNotes.size > 0) {
                    details.ingredients.forEach((ingredient: TaskIngredientDetail) => {
                        const note = ingredientNotes.get(ingredient.name);
                        if (note) {
                            const existingInfo = ingredient.extraInfo ? `${ingredient.extraInfo}\n` : '';
                            ingredient.extraInfo = `${existingInfo}${note}`;
                        }
                    });
                }
            }
            prepTaskItems.push(details);
        }

        return prepTaskItems;
    }

    private async _getPrepTaskSummary(
        tenantId: string,
        date?: string,
    ): Promise<Omit<PrepTask, 'items' | 'billOfMaterials'> | null> {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        // [核心修改] 查询逻辑变更为只查找在指定日期“开始”的任务
        const tasksStartingToday = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
                items: {
                    some: {
                        product: { deletedAt: null }, // [核心修改] 确保任务中的产品未被软删除
                    },
                },
                recipeSnapshot: { not: Prisma.JsonNull }, // [核心新增] 确保任务已有快照
            },
            // [核心修改] 包含 recipeSnapshot 以便用于计算
            // [FIX] 'recipeSnapshot' is not a relation, use 'select'
            select: {
                recipeSnapshot: true,
            },
        });

        if (tasksStartingToday.length === 0) {
            return null;
        }

        // [核心修改] 将任务的快照解析为 TaskWithDetails 对象
        const snapshotTasks = tasksStartingToday
            .map((task) => {
                if (!task.recipeSnapshot) return null;
                return task.recipeSnapshot as unknown as TaskWithDetails;
            })
            .filter((t): t is TaskWithDetails => t !== null);

        if (snapshotTasks.length === 0) {
            return null;
        }

        // [核心修改] 基于快照列表计算预制件和备料清单
        const combinedTaskItems = {
            ...snapshotTasks[0], // 用第一个快照作为基础结构
            items: snapshotTasks.flatMap((task) => task.items), // 合并所有快照中的 items
        };

        const [prepItems, billOfMaterials] = await Promise.all([
            this._getPrepItemsForTask(tenantId, combinedTaskItems),
            this._getBillOfMaterialsForDateInternal(tenantId, snapshotTasks), // [核心修改] 调用内部函数
        ]);

        const detailsParts: string[] = [];
        if (billOfMaterials.standardItems.length > 0 || billOfMaterials.nonInventoriedItems.length > 0) {
            detailsParts.push('备料清单');
        }
        if (prepItems.length > 0) {
            detailsParts.push(`${prepItems.length}种预制件`);
        }

        if (detailsParts.length === 0) {
            return null;
        }

        return {
            id: 'prep-task-combined',
            title: '前置准备任务',
            details: detailsParts.join('，'),
        };
    }

    async getPrepTaskDetails(tenantId: string, date?: string): Promise<PrepTask | null> {
        const summary = await this._getPrepTaskSummary(tenantId, date);
        if (!summary) {
            return null;
        }

        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        // [核心修改] 查询逻辑同样变更为只查找在指定日期“开始”的任务
        const tasksStartingToday = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
                items: {
                    some: {
                        product: { deletedAt: null }, // [核心修改] 确保任务中的产品未被软删除
                    },
                },
                recipeSnapshot: { not: Prisma.JsonNull }, // [核心新增] 确保任务已有快照
            },
            // [核心修改] 包含 recipeSnapshot 以便用于计算
            // [FIX] 'recipeSnapshot' is not a relation, use 'select'
            select: {
                recipeSnapshot: true,
            },
        });

        if (tasksStartingToday.length === 0) {
            return null;
        }

        // [核心修改] 将任务的快照解析为 TaskWithDetails 对象
        const snapshotTasks = tasksStartingToday
            .map((task) => {
                if (!task.recipeSnapshot) return null;
                return task.recipeSnapshot as unknown as TaskWithDetails;
            })
            .filter((t): t is TaskWithDetails => t !== null);

        if (snapshotTasks.length === 0) {
            return null;
        }

        // [核心修改] 基于快照列表计算预制件和备料清单
        const combinedTaskItems = {
            ...snapshotTasks[0], // 用第一个快照作为基础结构
            items: snapshotTasks.flatMap((task) => task.items), // 合并所有快照中的 items
        };

        const [prepItems, billOfMaterials] = await Promise.all([
            this._getPrepItemsForTask(tenantId, combinedTaskItems),
            this._getBillOfMaterialsForDateInternal(tenantId, snapshotTasks),
        ]);

        return {
            ...summary,
            items: prepItems,
            billOfMaterials,
        };
    }

    async findActive(tenantId: string, date?: string) {
        const [tasksForDate, dateStats] = await Promise.all([
            this.findTasksForDate(tenantId, date),
            this.getPendingStatsForDate(tenantId, date),
        ]);

        const prepTaskSummary = await this._getPrepTaskSummary(tenantId, date);

        const inProgressTasks = tasksForDate.filter((task) => task.status === 'IN_PROGRESS');
        const pendingTasks = tasksForDate.filter((task) => task.status === 'PENDING');

        inProgressTasks.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        pendingTasks.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

        const sortedRegularTasks = [...inProgressTasks, ...pendingTasks];

        const combinedTasks: (
            | (ProductionTask & { items: { product: { name: string }; quantity: number }[] })
            | (Omit<PrepTask, 'items' | 'billOfMaterials'> & { status: 'PREP' })
        )[] = [...sortedRegularTasks];

        if (prepTaskSummary) {
            combinedTasks.unshift({ ...prepTaskSummary, status: 'PREP' });
        }

        return {
            stats: dateStats,
            tasks: combinedTasks,
            prepTask: null,
        };
    }

    private async findTasksForDate(tenantId: string, date?: string) {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
            status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
            startDate: {
                lte: endOfDay,
            },
            OR: [
                {
                    endDate: {
                        gte: startOfDay,
                    },
                },
                {
                    endDate: null,
                },
            ],
            items: {
                some: {
                    product: { deletedAt: null }, // [核心修改] 只显示产品未被删除的任务
                },
            },
        };

        return this.prisma.productionTask.findMany({
            where,
            include: taskListItemsInclude,
            orderBy: {
                startDate: 'asc',
            },
        });
    }

    private async getPendingStatsForDate(tenantId: string, date?: string) {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(
            targetDate.getFullYear(),
            targetDate.getMonth(),
            targetDate.getDate(),
            23,
            59,
            59,
            999,
        );

        const pendingTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                deletedAt: null,
                startDate: {
                    lte: endOfDay,
                },
                OR: [
                    {
                        endDate: {
                            gte: startOfDay,
                        },
                    },
                    {
                        endDate: null,
                    },
                ],
                items: {
                    some: {
                        product: { deletedAt: null }, // [核心修改] 只统计产品未被删除的任务
                    },
                },
            },
            include: {
                items: true,
            },
        });

        const pendingCount = pendingTasks.reduce((sum, task) => {
            return sum + task.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
        }, 0);

        return {
            pendingCount: pendingCount,
        };
    }

    async getTaskDates(tenantId: string) {
        const tasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                items: {
                    some: {
                        product: { deletedAt: null }, // [核心修改] 只统计产品未被删除的任务
                    },
                },
            },
            select: {
                startDate: true,
                endDate: true,
            },
        });

        const dates = new Set<string>();
        tasks.forEach((task) => {
            const current = new Date(task.startDate);
            const end = task.endDate ? new Date(task.endDate) : new Date(task.startDate);

            current.setUTCHours(0, 0, 0, 0);
            end.setUTCHours(0, 0, 0, 0);

            while (current <= end) {
                dates.add(current.toISOString().split('T')[0]);
                current.setDate(current.getDate() + 1);
            }
        });

        return Array.from(dates);
    }

    getSpoilageStages() {
        return spoilageStages;
    }

    async findHistory(tenantId: string, query: QueryProductionTaskDto) {
        const { page, limit = '10' } = query;
        const pageNum = parseInt(page || '1', 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
            status: { in: [ProductionTaskStatus.COMPLETED, ProductionTaskStatus.CANCELLED] },
        };

        const tasks = await this.prisma.productionTask.findMany({
            where,
            include: taskListItemsInclude,
            orderBy: {
                updatedAt: 'desc',
            },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        const groupedTasks = tasks.reduce((acc: Record<string, typeof tasks>, task) => {
            const date = new Date(task.updatedAt).toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
            });
            if (!acc[date]) {
                acc[date] = [];
            }
            acc[date].push(task);
            return acc;
        }, {});

        const totalTasks = await this.prisma.productionTask.count({ where });

        return {
            data: groupedTasks,
            meta: {
                total: totalTasks,
                page: pageNum,
                limit: limitNum,
                lastPage: Math.ceil(totalTasks / limitNum),
                hasMore: pageNum * limitNum < totalTasks,
            },
        };
    }

    /**
     * [核心修改] 此函数基于传入的“产品详情”（来自快照或实时）计算BOM
     */
    private _getFlattenedIngredientsForBOM(product: ProductWithDetails): Map<string, Prisma.Decimal> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();
        if (!product.recipeVersion || product.deletedAt) {
            // [核心修改] 增加软删除检查
            return flattenedIngredients;
        }

        const mainComponent = product.recipeVersion.components[0];
        if (!mainComponent) return flattenedIngredients;

        const baseDoughWeight = new Prisma.Decimal(product.baseDoughWeight);
        const divisionLoss = new Prisma.Decimal(mainComponent.divisionLoss || 0);
        const divisionLossFactor = baseDoughWeight.isZero()
            ? new Prisma.Decimal(1)
            : baseDoughWeight.add(divisionLoss).div(baseDoughWeight);

        const processComponentWithLoss = (
            component: ComponentWithIngredients,
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
                        processComponentWithLoss(preDoughComponent as ComponentWithIngredients, ingredientInputWeight);
                    }
                } else if (ing.ingredientId) {
                    const currentWeight = flattenedIngredients.get(ing.ingredientId) || new Prisma.Decimal(0);
                    flattenedIngredients.set(ing.ingredientId, currentWeight.add(ingredientInputWeight));
                }
            }
        };

        const theoreticalFlourWeightPerUnit = this._calculateTheoreticalTotalFlourWeightForProduct(product);

        const mainDoughLossDivisor = new Prisma.Decimal(1).sub(mainComponent.lossRatio || 0);
        if (mainDoughLossDivisor.isZero() || mainDoughLossDivisor.isNegative()) return flattenedIngredients;

        for (const ing of mainComponent.ingredients) {
            let theoreticalWeight: Prisma.Decimal;
            if (ing.linkedPreDough && ing.flourRatio) {
                const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                if (!preDoughRecipe) continue;
                const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                    (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                    new Prisma.Decimal(0),
                );
                theoreticalWeight = theoreticalFlourWeightPerUnit
                    .mul(new Prisma.Decimal(ing.flourRatio)) // [修复] 确保从快照加载时转换为Decimal
                    .mul(preDoughTotalRatio);
            } else if (ing.ingredient && ing.ratio) {
                theoreticalWeight = theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(ing.ratio)); // [修复] 确保从快照加载时转换为Decimal
            } else {
                continue;
            }

            const requiredOutputWeight = theoreticalWeight.mul(divisionLossFactor).div(mainDoughLossDivisor);

            if (ing.linkedPreDough) {
                const preDoughComponent = ing.linkedPreDough.versions?.[0]?.components?.[0];
                if (preDoughComponent) {
                    processComponentWithLoss(preDoughComponent as ComponentWithIngredients, requiredOutputWeight);
                }
            } else if (ing.ingredientId) {
                const currentWeight = flattenedIngredients.get(ing.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(ing.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

        for (const pIng of product.ingredients || []) {
            let theoreticalWeight = new Prisma.Decimal(0);
            if (pIng.weightInGrams) {
                theoreticalWeight = new Prisma.Decimal(pIng.weightInGrams);
            } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                theoreticalWeight = theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(pIng.ratio)); // [修复] 确保从快照加载时转换为Decimal
            } else {
                continue;
            }

            let requiredOutputWeight = theoreticalWeight;
            if (pIng.type === 'MIX_IN') {
                requiredOutputWeight = theoreticalWeight.mul(divisionLossFactor).div(mainDoughLossDivisor);
            }

            if (pIng.linkedExtra) {
                const extraComponent = pIng.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    processComponentWithLoss(extraComponent as ComponentWithIngredients, requiredOutputWeight);
                }
            } else if (pIng.ingredientId) {
                const currentWeight = flattenedIngredients.get(pIng.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(pIng.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

        return flattenedIngredients;
    }

    /**
     * [核心修改] 此方法现在基于“快照”列表计算BOM
     */
    private async _calculateBillOfMaterialsForTasks(
        tenantId: string,
        tasks: TaskWithDetails[], // [核心修改] 接收一个 TaskWithDetails 数组（来自快照）
    ): Promise<BillOfMaterialsResponseDto> {
        const totalConsumptionMap = new Map<string, Prisma.Decimal>();

        for (const task of tasks) {
            for (const item of task.items) {
                if (item.product.deletedAt) continue; // [核心修改] 跳过已软删除的产品
                // [核心修改] _getFlattenedIngredientsForBOM 现在基于快照中的 product 对象进行计算
                const consumptions = this._getFlattenedIngredientsForBOM(item.product);

                for (const [ingredientId, weight] of consumptions.entries()) {
                    const totalRequiredForItem = weight.mul(item.quantity);
                    const existing = totalConsumptionMap.get(ingredientId) || new Prisma.Decimal(0);
                    totalConsumptionMap.set(ingredientId, existing.add(totalRequiredForItem));
                }
            }
        }

        const ingredientIds = Array.from(totalConsumptionMap.keys());
        if (ingredientIds.length === 0) {
            return { standardItems: [], nonInventoriedItems: [] };
        }

        // [核心修改] 此处查询的是“实时”库存，这是正确的
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                name: true,
                type: true,
                currentStockInGrams: true,
                activeSku: {
                    select: {
                        brand: true,
                    },
                },
            },
        });

        const standardItems: BillOfMaterialsItem[] = [];
        const nonInventoriedItems: BillOfMaterialsItem[] = [];

        for (const ingredient of ingredients) {
            const requiredDecimal = totalConsumptionMap.get(ingredient.id);
            if (!requiredDecimal) continue;
            const required = requiredDecimal.toNumber();
            const brand = ingredient.activeSku?.brand || null;

            if (ingredient.type === IngredientType.STANDARD) {
                const currentStock = ingredient.currentStockInGrams.toNumber();

                standardItems.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    brand,
                    currentStock,
                    totalRequired: required,
                });
            } else if (ingredient.type === IngredientType.NON_INVENTORIED) {
                nonInventoriedItems.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    brand,
                    totalRequired: required,
                });
            }
        }

        standardItems.sort((a, b) => b.totalRequired - a.totalRequired);
        nonInventoriedItems.sort((a, b) => b.totalRequired - a.totalRequired);

        return { standardItems, nonInventoriedItems };
    }

    /**
     * [核心修改] 这是一个新的内部函数，它接收解析后的快照列表
     */
    private async _getBillOfMaterialsForDateInternal(
        tenantId: string,
        snapshotTasks: TaskWithDetails[],
    ): Promise<BillOfMaterialsResponseDto> {
        if (snapshotTasks.length === 0) {
            return { standardItems: [], nonInventoriedItems: [] };
        }

        return this._calculateBillOfMaterialsForTasks(tenantId, snapshotTasks);
    }

    async getBillOfMaterialsForDate(tenantId: string, date?: string): Promise<BillOfMaterialsResponseDto> {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        // [核心修改] 查询逻辑变更为只查找在指定日期“开始”的任务
        const tasksStartingToday = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
                items: {
                    some: {
                        product: { deletedAt: null }, // [核心修改] 确保任务中的产品未被软删除
                    },
                },
                recipeSnapshot: { not: Prisma.JsonNull }, // [核心新增] 确保任务已有快照
            },
            // [核心修改] 包含 recipeSnapshot 以便用于计算
            select: {
                recipeSnapshot: true,
            },
        });

        if (tasksStartingToday.length === 0) {
            return { standardItems: [], nonInventoriedItems: [] };
        }

        // [核心修改] 将任务的快照解析为 TaskWithDetails 对象
        const snapshotTasks = tasksStartingToday
            .map((task) => {
                if (!task.recipeSnapshot) return null;
                return task.recipeSnapshot as unknown as TaskWithDetails;
            })
            .filter((t): t is TaskWithDetails => t !== null);

        // [核心修改] 调用基于快照列表的内部函数
        return this._getBillOfMaterialsForDateInternal(tenantId, snapshotTasks);
    }

    async findOne(tenantId: string, id: string, query: QueryTaskDetailDto): Promise<TaskDetailResponseDto> {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            // [核心修改] 只需获取任务基本信息和快照
            select: {
                id: true,
                status: true,
                notes: true,
                items: {
                    select: {
                        quantity: true,
                        product: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                recipeSnapshot: true,
            },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        // [核心修改] 任务详情（包括历史任务）现在*必须*基于快照
        if (!task.recipeSnapshot) {
            // [核心新增] 如果快照不存在（例如旧数据或创建失败），尝试动态生成
            // 注意：这可能导致 `PENDING` 任务看到实时数据，但在 `complete` 时会出错
            // 一个更严格的策略是： if (task.status !== 'PENDING') throw new NotFoundException('任务数据快照丢失');
            // 这里我们采用宽松策略，尝试在 `findOne` 时修复
            try {
                task.recipeSnapshot = await this._fetchAndSerializeSnapshot(id);
                // (不保存到数据库，只用于本次读取)
            } catch (error) {
                // [FIX] 安全地访问 error.message
                const message = error instanceof Error ? error.message : String(error);
                throw new NotFoundException(`生产任务数据不完整或快照丢失: ${message}`);
            }
        }

        // [核心修改] 任务数据源*始终*是快照
        const taskDataForCalc = task.recipeSnapshot as unknown as TaskWithDetails;

        const componentGroups = this._calculateComponentGroups(taskDataForCalc, query, task.items);
        const { stockWarning } = await this._calculateStockWarning(tenantId, taskDataForCalc);

        // [核心修改] 预制件任务也基于快照计算
        const prepItems = await this._getPrepItemsForTask(tenantId, taskDataForCalc);

        return {
            id: task.id,
            status: task.status,
            notes: task.notes,
            stockWarning,
            prepTask: {
                id: 'prep-task-combined',
                title: '前置准备任务',
                details: prepItems.length > 0 ? `包含 ${prepItems.length} 种预制件` : '',
                items: prepItems,
            },
            componentGroups,
            items: task.items.map((item) => ({
                id: item.product.id,
                name: item.product.name,
                plannedQuantity: item.quantity,
            })),
        };
    }

    private _parseAndCalculateProcedureNotes(
        procedure: string[] | undefined | null,
        baseForPercentageCalc: Prisma.Decimal,
    ): { processedProcedure: string[]; ingredientNotes: Map<string, string> } {
        if (!procedure) {
            return { processedProcedure: [], ingredientNotes: new Map() };
        }

        const tempNotes = new Map<string, string[]>();
        const percentageRegex = /\[(\d+(?:\.\d+)?)%\]/g;
        const noteRegex = /@([^（(]+?)\s*?[（(]([^)）]+?)[)）]/g;

        const processedProcedure = procedure
            .map((step) => {
                let currentStep = step;
                if (!baseForPercentageCalc.isZero()) {
                    currentStep = step.replace(percentageRegex, (match: string, p1: string) => {
                        const percentage = new Prisma.Decimal(p1);
                        const calculatedWeight = baseForPercentageCalc.mul(percentage.div(100));
                        return `${calculatedWeight.toDP(2).toNumber()}克`;
                    });
                }

                const noteMatches = [...currentStep.matchAll(noteRegex)];
                for (const noteMatch of noteMatches) {
                    const ingredientName = noteMatch[1].trim();
                    const content = noteMatch[2].trim();
                    if (!tempNotes.has(ingredientName)) {
                        tempNotes.set(ingredientName, []);
                    }
                    tempNotes.get(ingredientName)!.push(content);
                }

                const cleanedStep = currentStep.replace(noteRegex, '').trim();

                if (cleanedStep === '') {
                    return null;
                }
                return cleanedStep;
            })
            .filter((step): step is string => step !== null);

        const ingredientNotes = new Map<string, string>();
        tempNotes.forEach((notes, name) => {
            ingredientNotes.set(name, notes.join(' '));
        });

        return { processedProcedure, ingredientNotes };
    }

    private _parseProcedureForNotes(
        procedure: string[] | undefined | null,
        ingredientNotes: Map<string, string>,
        // ): string[] { // [核心修复] 修改返回类型声明
    ): { cleanedProcedure: string[]; ingredientNotes: Map<string, string> } {
        if (!procedure) {
            // return []; // [核心修复] 调整返回值以匹配新的类型
            return { cleanedProcedure: [], ingredientNotes };
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

        // return cleanedProcedure; // [核心修复] 调整返回值以匹配新的类型
        return { cleanedProcedure, ingredientNotes };
    }

    /**
     * [核心修改] 此方法现在基于“快照”计算
     * @param task 快照中的 TaskWithDetails 对象
     * @param originalItems 任务的“实时” item 列表（仅用于获取计划数量）
     */
    private _calculateComponentGroups(
        task: TaskWithDetails,
        query: QueryTaskDetailDto,
        originalItems: { quantity: number; product: { id: string } }[], // [核心修改] 简化类型
    ): ComponentGroup[] {
        const { mixerType, envTemp, flourTemp, waterTemp } = query;
        const canCalculateIce =
            mixerType !== undefined && envTemp !== undefined && flourTemp !== undefined && waterTemp !== undefined;

        const originalItemsMap = new Map(originalItems.map((item) => [item.product.id, item]));

        const componentsMap = new Map<
            string,
            { familyName: string; category: RecipeCategory; items: TaskItemWithDetails[] }
        >();
        // [核心修改] 遍历来自“快照”的 items
        task.items.forEach((item) => {
            if (item.product.deletedAt) return; // [核心修改] 跳过已软删除的产品
            const family = item.product.recipeVersion.family;
            if (!componentsMap.has(family.id)) {
                componentsMap.set(family.id, {
                    familyName: family.name,
                    category: family.category,
                    items: [],
                });
            }
            componentsMap.get(family.id)!.items.push(item);
        });

        const componentGroups: ComponentGroup[] = [];
        for (const [familyId, data] of componentsMap.entries()) {
            const firstItem = data.items[0];

            const versionNotes = (firstItem.product.recipeVersion as unknown as { notes: string | null }).notes;

            const baseComponentInfo = firstItem.product.recipeVersion.components[0];

            let totalFlourForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                // [核心修改] 从 originalItemsMap 获取“计划数量”
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                // [核心修改] _calculateTotalFlourWeightForProduct 基于“快照”中的 product 计算
                const flourPerUnit = this._calculateTotalFlourWeightForProduct(item.product);
                totalFlourForFamily = totalFlourForFamily.add(flourPerUnit.mul(quantity));
            }

            const { processedProcedure, ingredientNotes } = this._parseAndCalculateProcedureNotes(
                baseComponentInfo.procedure,
                totalFlourForFamily,
            );

            const baseComponentIngredientsMap = new Map<string, TaskIngredientDetail>();
            let totalComponentWeight = new Prisma.Decimal(0);

            let totalWaterForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                // [核心修改] _calculateTotalWaterWeightForProduct 基于“快照”中的 product 计算
                const waterPerUnit = this._calculateTotalWaterWeightForProduct(item.product);
                totalWaterForFamily = totalWaterForFamily.add(waterPerUnit.mul(quantity));
            }

            let waterIngredientId: string | null = null;
            for (const ing of baseComponentInfo.ingredients) {
                if (ing.ingredient?.name === '水') {
                    waterIngredientId = ing.ingredient.id;
                    break;
                }
            }

            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                const totalFlour = this._calculateTotalFlourWeightForProduct(item.product);
                for (const ing of baseComponentInfo.ingredients) {
                    let weight: Prisma.Decimal;
                    let id: string;
                    let name: string;
                    let brand: string | null = null;
                    let isRecipe = false;

                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                        if (!preDoughRecipe) continue;

                        const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        weight = totalFlour.mul(new Prisma.Decimal(ing.flourRatio)).mul(preDoughTotalRatio); // [修复] 确保从快照加载时转换为Decimal
                        id = ing.linkedPreDough.id;
                        name = ing.linkedPreDough.name;
                        isRecipe = true;
                        brand = '自制面种';
                    } else if (ing.ingredient && ing.ratio) {
                        weight = totalFlour.mul(new Prisma.Decimal(ing.ratio)); // [修复] 确保从快照加载时转换为Decimal
                        id = ing.ingredient.id;
                        name = ing.ingredient.name;
                        brand = ing.ingredient.activeSku?.brand || null;
                    } else {
                        continue;
                    }

                    const currentTotalWeight = weight.mul(quantity);
                    totalComponentWeight = totalComponentWeight.add(currentTotalWeight);

                    const existing = baseComponentIngredientsMap.get(id);
                    if (existing) {
                        existing.weightInGrams += currentTotalWeight.toNumber();
                    } else {
                        const newIngredient: TaskIngredientDetail = {
                            id,
                            name,
                            brand,
                            weightInGrams: currentTotalWeight.toNumber(),
                            isRecipe,
                            extraInfo: ingredientNotes.get(name) || null,
                        };
                        baseComponentIngredientsMap.set(id, newIngredient);
                    }
                }
            }

            if (canCalculateIce && baseComponentInfo.targetTemp && waterIngredientId) {
                const waterIngredient = baseComponentIngredientsMap.get(waterIngredientId);
                if (waterIngredient) {
                    const autoCalculatedParts: string[] = [];
                    const targetWaterTemp = this._calculateWaterTemp(
                        new Prisma.Decimal(baseComponentInfo.targetTemp).toNumber(), // [修复] 确保从快照加载时转换为Decimal
                        mixerType,
                        flourTemp,
                        envTemp,
                    );
                    const iceWeight = this._calculateIce(targetWaterTemp, totalWaterForFamily.toNumber(), waterTemp);

                    if (iceWeight > totalWaterForFamily.toNumber()) {
                        const requiredTemp = this._calculateRequiredWetIngredientTemp(
                            targetWaterTemp,
                            totalWaterForFamily.toNumber(),
                            totalWaterForFamily.toNumber(),
                        );
                        autoCalculatedParts.push(
                            `需将所有水换成冰块，且其他液体原料需冷却至 ${new Prisma.Decimal(requiredTemp)
                                .toDP(1)
                                .toNumber()}°C`,
                        );
                    } else if (iceWeight > 0) {
                        autoCalculatedParts.push(`需要替换 ${new Prisma.Decimal(iceWeight).toDP(1).toNumber()}g 冰`);
                    }

                    const finalInfoParts: string[] = [];
                    if (autoCalculatedParts.length > 0) {
                        finalInfoParts.push(...autoCalculatedParts);
                    }

                    if (waterIngredient.extraInfo) {
                        finalInfoParts.push(waterIngredient.extraInfo);
                    }

                    if (finalInfoParts.length > 0) {
                        waterIngredient.extraInfo = finalInfoParts.join('\n');
                    }
                }
            }

            const products: ProductComponentSummary[] = [];
            const productDetails: ProductDetails[] = [];
            data.items.forEach((item) => {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                if (quantity === 0) return;

                const { product } = item;

                const flourWeightPerUnitWithLoss = this._calculateTotalFlourWeightForProduct(product);

                const flattenedProductIngredients = this._flattenIngredientsForProduct(product, false);

                const mixIns: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: flourWeightPerUnitWithLoss
                            .mul(new Prisma.Decimal(ing.ratio ?? 0)) // [修复] 确保从快照加载时转换为Decimal
                            .toNumber(),
                    }));

                const fillings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'FILLING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: new Prisma.Decimal(ing.weightInGrams ?? 0).toNumber(), // [修复] 确保从快照加载时转换为Decimal
                    }));

                const toppings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'TOPPING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: new Prisma.Decimal(ing.weightInGrams ?? 0).toNumber(), // [修复] 确保从快照加载时转换为Decimal
                    }));

                const theoreticalFlourWeightPerUnit = this._calculateTheoreticalTotalFlourWeightForProduct(product);
                const theoreticalMixInWeightPerUnit = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .reduce(
                        (sum, ing) => sum.add(theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(ing.ratio ?? 0))), // [修复] 确保从快照加载时转换为Decimal
                        new Prisma.Decimal(0),
                    );

                const correctedDivisionWeight = new Prisma.Decimal(product.baseDoughWeight).add(
                    theoreticalMixInWeightPerUnit,
                );

                const lossRatio = new Prisma.Decimal(baseComponentInfo.lossRatio || 0);
                const divisor = new Prisma.Decimal(1).sub(lossRatio);

                const divisionLoss = new Prisma.Decimal(baseComponentInfo.divisionLoss || 0);

                const targetBaseDoughWeight = new Prisma.Decimal(product.baseDoughWeight).add(divisionLoss);

                const singleUnitInputWeight =
                    divisor.isZero() || divisor.isNegative()
                        ? targetBaseDoughWeight
                        : targetBaseDoughWeight.div(divisor);

                const totalBaseComponentWeightWithLoss = singleUnitInputWeight.mul(quantity);

                products.push({
                    id: product.id,
                    name: product.name,
                    quantity: quantity,
                    totalBaseComponentWeight: totalBaseComponentWeightWithLoss.toNumber(),
                    divisionWeight: correctedDivisionWeight.toNumber(),
                });

                productDetails.push({
                    id: product.id,
                    name: product.name,
                    mixIns: mixIns.map((i) => ({ ...i, weightInGrams: i.weightInGrams * quantity })),
                    fillings: fillings.map((i) => ({
                        ...i,
                        weightPerUnit: i.weightInGrams,
                        weightInGrams: i.weightInGrams * quantity,
                    })),
                    toppings: toppings.map((i) => ({
                        ...i,
                        weightPerUnit: i.weightInGrams,
                        weightInGrams: i.weightInGrams * quantity,
                    })),
                    procedure: product.procedure || [],
                });
            });

            componentGroups.push({
                familyId,
                familyName: data.familyName,
                note: versionNotes,
                category: data.category,
                productsDescription: data.items
                    .map((i) => {
                        const originalItem = originalItemsMap.get(i.productId);
                        const quantity = originalItem?.quantity ?? 0;
                        return `${i.product.name} x${quantity}`;
                    })
                    .join(', '),
                totalComponentWeight: totalComponentWeight.toNumber(),
                baseComponentIngredients: Array.from(baseComponentIngredientsMap.values()).sort(
                    (a, b) => (b.isRecipe ? 1 : 0) - (a.isRecipe ? 1 : 0),
                ),
                baseComponentProcedure: processedProcedure,
                products,
                productDetails,
            });
        }
        return componentGroups;
    }

    /**
     * [核心修改] 此方法现在基于“快照”中的 product 对象计算
     */
    private _flattenIngredientsForProduct(
        product: ProductWithDetails,
        includeDough = true,
    ): Map<string, FlattenedIngredient> {
        const flattened = new Map<string, FlattenedIngredient>();
        // [修复] 增加安全检查
        if (!product.recipeVersion || product.deletedAt) {
            // [核心修改] 增加软删除检查
            return flattened;
        }

        const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

        if (includeDough) {
            const processDough = (dough: ComponentWithRecursiveIngredients, flourWeightRef: Prisma.Decimal) => {
                for (const ing of dough.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                        if (preDoughRecipe) {
                            const flourForPreDough = flourWeightRef.mul(new Prisma.Decimal(ing.flourRatio)); // [修复] 确保从快照加载时转换为Decimal
                            processDough(preDoughRecipe as ComponentWithRecursiveIngredients, flourForPreDough);
                        }
                    } else if (ing.ingredient && ing.ratio) {
                        const weight = flourWeightRef.mul(new Prisma.Decimal(ing.ratio)); // [修复] 确保从快照加载时转换为Decimal

                        const existing = flattened.get(ing.ingredient.id);
                        if (existing) {
                            existing.weight = existing.weight.add(weight);
                        } else {
                            flattened.set(ing.ingredient.id, {
                                id: ing.ingredient.id,
                                name: ing.ingredient.name,
                                weight: weight,
                                brand: ing.ingredient.activeSku?.brand || null,
                                isRecipe: false,
                                waterContent: new Prisma.Decimal(ing.ingredient.waterContent), // [修复] 确保从快照加载时转换为Decimal
                            });
                        }
                    }
                }
            };
            processDough(product.recipeVersion.components[0], totalFlourWeight);
        }

        for (const pIng of product.ingredients) {
            if (pIng.ingredient) {
                const uniqueKey = `${pIng.ingredient.id}-${pIng.type}`;
                flattened.set(uniqueKey, {
                    id: pIng.ingredient.id,
                    name: pIng.ingredient.name,
                    weight: new Prisma.Decimal(0),
                    brand: pIng.ingredient.activeSku?.brand || null,
                    isRecipe: false,
                    type: pIng.type,
                    ratio: pIng.ratio ? new Prisma.Decimal(pIng.ratio) : undefined, // [修复] 确保从快照加载时转换为Decimal
                    weightInGrams: pIng.weightInGrams ? new Prisma.Decimal(pIng.weightInGrams) : undefined, // [修复] 确保从快照加载时转换为Decimal
                    waterContent: new Prisma.Decimal(pIng.ingredient.waterContent), // [修复] 确保从快照加载时转换为Decimal
                });
            } else if (pIng.linkedExtra) {
                const uniqueKey = `${pIng.linkedExtra.id}-${pIng.type}`;
                flattened.set(uniqueKey, {
                    id: pIng.linkedExtra.id,
                    name: pIng.linkedExtra.name,
                    weight: new Prisma.Decimal(0),
                    brand: null,
                    isRecipe: true,
                    recipeType: pIng.linkedExtra.type,
                    recipeFamily: pIng.linkedExtra,
                    type: pIng.type,
                    ratio: pIng.ratio ? new Prisma.Decimal(pIng.ratio) : undefined, // [修复] 确保从快照加载时转换为Decimal
                    weightInGrams: pIng.weightInGrams ? new Prisma.Decimal(pIng.weightInGrams) : undefined, // [修复] 确保从快照加载时转换为Decimal
                });
            }
        }

        return flattened;
    }

    /**
     * [核心修改] 此方法现在基于“快照”中的 product 对象计算
     */
    private _calculateTheoreticalTotalFlourWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        if (!product.recipeVersion || product.deletedAt) {
            // [核心修改] 增加软删除检查
            return new Prisma.Decimal(0);
        }
        const mainDough = product.recipeVersion.components[0];
        if (!mainDough) return new Prisma.Decimal(0);

        const theoreticalDoughWeight = new Prisma.Decimal(product.baseDoughWeight);

        const calculateTotalRatio = (dough: ComponentWithRecursiveIngredients): Prisma.Decimal => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        return sum.add(new Prisma.Decimal(i.flourRatio).mul(preDoughTotalRatio)); // [修复] 确保从快照加载时转换为Decimal
                    }
                }
                return sum.add(new Prisma.Decimal(i.ratio ?? 0)); // [修复] 确保从快照加载时转换为Decimal
            }, new Prisma.Decimal(0));
        };

        const totalRatio = calculateTotalRatio(mainDough);
        if (totalRatio.isZero()) return new Prisma.Decimal(0);

        return theoreticalDoughWeight.div(totalRatio);
    }

    /**
     * [核心修改] 此方法现在基于“快照”中的 product 对象计算
     */
    private _calculateTotalWaterWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        if (!product.recipeVersion || product.deletedAt) {
            // [核心修改] 增加软删除检查
            return new Prisma.Decimal(0);
        }
        const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
        let totalWaterWeight = new Prisma.Decimal(0);

        const findWaterRecursively = (component: ComponentWithRecursiveIngredients, flourRef: Prisma.Decimal) => {
            for (const ing of component.ingredients) {
                if (ing.linkedPreDough && ing.flourRatio) {
                    const preDoughComponent = ing.linkedPreDough.versions?.find((v) => v.isActive)?.components[0];
                    if (preDoughComponent) {
                        const flourForPreDough = flourRef.mul(new Prisma.Decimal(ing.flourRatio)); // [修复] 确保从快照加载时转换为Decimal
                        findWaterRecursively(preDoughComponent as ComponentWithRecursiveIngredients, flourForPreDough);
                    }
                } else if (ing.ingredient?.waterContent && ing.ratio) {
                    // [!! 核心修复 !!]
                    // 1. 将 ing.ingredient.waterContent 和 ing.ratio (来自JSON) 转换为 Prisma.Decimal
                    // 2. 检查转换后的 waterContentDecimal 是否 .gt(0)
                    const waterContentDecimal = new Prisma.Decimal(ing.ingredient.waterContent);
                    if (waterContentDecimal.gt(0)) {
                        const ratioDecimal = new Prisma.Decimal(ing.ratio);
                        const waterWeight = flourRef.mul(ratioDecimal).mul(waterContentDecimal);
                        totalWaterWeight = totalWaterWeight.add(waterWeight);
                    }
                }
            }
        };

        const mainComponent = product.recipeVersion.components[0];
        if (mainComponent) {
            findWaterRecursively(mainComponent, totalFlourWeight);
        }

        return totalWaterWeight;
    }

    /**
     * [核心修改] 此方法现在基于“快照”中的 product 对象计算
     */
    private _calculateTotalFlourWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        if (!product.recipeVersion || product.deletedAt) {
            // [核心修改] 增加软删除检查
            return new Prisma.Decimal(0);
        }
        const mainDough = product.recipeVersion.components[0];
        if (!mainDough) return new Prisma.Decimal(0);

        const lossRatio = new Prisma.Decimal(mainDough.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);
        if (divisor.isZero() || divisor.isNegative()) return new Prisma.Decimal(0);

        const divisionLoss = new Prisma.Decimal(mainDough.divisionLoss || 0);
        const targetBaseDoughWeight = new Prisma.Decimal(product.baseDoughWeight).add(divisionLoss);
        const adjustedDoughWeight = targetBaseDoughWeight.div(divisor);

        const calculateTotalRatio = (dough: ComponentWithRecursiveIngredients): Prisma.Decimal => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        return sum.add(new Prisma.Decimal(i.flourRatio).mul(preDoughTotalRatio)); // [修复] 确保从快照加载时转换为Decimal
                    }
                }
                return sum.add(new Prisma.Decimal(i.ratio ?? 0)); // [修复] 确保从快照加载时转换为Decimal
            }, new Prisma.Decimal(0));
        };

        const totalRatio = calculateTotalRatio(mainDough);
        if (totalRatio.isZero()) return new Prisma.Decimal(0);

        return adjustedDoughWeight.div(totalRatio);
    }

    /**
     * [核心修改] 此方法现在基于“快照”计算需求，但对比“实时”库存
     */
    private async _calculateStockWarning(tenantId: string, task: TaskWithDetails) {
        const totalIngredientsMap = new Map<string, { name: string; totalWeight: number }>();
        // [核心修改] 不再需要 Promise.all，因为快照数据是同步的
        for (const item of task.items) {
            if (item.product.deletedAt) continue; // [核心修改] 跳过已软删除的产品
            // [核心修改] 基于快照中的 product 计算
            const consumptions = this._getFlattenedIngredientsForBOM(item.product);
            for (const [ingredientId, weight] of consumptions.entries()) {
                const totalWeight = weight.mul(item.quantity);
                const existing = totalIngredientsMap.get(ingredientId);
                // [核心修改] 从快照中获取原料名称
                const ingInfo = this._findIngredientInSnapshot(task, ingredientId);

                if (existing) {
                    existing.totalWeight += totalWeight.toNumber();
                } else {
                    totalIngredientsMap.set(ingredientId, {
                        name: ingInfo?.name || '未知原料',
                        totalWeight: totalWeight.toNumber(),
                    });
                }
            }
        }

        let stockWarning: string | null = null;
        const ingredientIds = Array.from(totalIngredientsMap.keys());
        if (ingredientIds.length > 0) {
            // [核心修改] 查询“实时”库存
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, type: true },
            });
            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);
            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];

            for (const [ingredientId, data] of totalIngredientsMap.entries()) {
                const ingredient = ingredientStockMap.get(ingredientId);
                if (ingredient && new Prisma.Decimal(ingredient.currentStockInGrams).lt(data.totalWeight)) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }
        return { stockWarning };
    }

    // [核心新增] 辅助函数：从复杂的快照对象中查找原料信息
    private _findIngredientInSnapshot(task: TaskWithDetails, ingredientId: string) {
        for (const item of task.items) {
            for (const component of item.product.recipeVersion?.components || []) {
                for (const ing of component.ingredients) {
                    if (ing.ingredient?.id === ingredientId) return ing.ingredient;
                    // [修复] 递归查找 preDough 内部
                    if (ing.linkedPreDough) {
                        for (const v of ing.linkedPreDough.versions) {
                            for (const c of v.components) {
                                for (const ci of c.ingredients) {
                                    if (ci.ingredient?.id === ingredientId) return ci.ingredient;
                                }
                            }
                        }
                    }
                }
            }
            for (const pIng of item.product.ingredients || []) {
                if (pIng.ingredient?.id === ingredientId) return pIng.ingredient;
                // [修复] 递归查找 linkedExtra 内部
                if (pIng.linkedExtra) {
                    for (const v of pIng.linkedExtra.versions) {
                        for (const c of v.components) {
                            for (const ci of c.ingredients) {
                                if (ci.ingredient?.id === ingredientId) return ci.ingredient;
                            }
                        }
                    }
                }
            }
        }
        return null;
    }

    async updateTaskDetails(tenantId: string, id: string, updateDto: UpdateTaskDetailsDto) {
        return this.prisma.$transaction(async (tx) => {
            const task = await tx.productionTask.findFirst({
                where: {
                    id,
                    tenantId,
                    deletedAt: null,
                },
            });

            if (!task) {
                throw new NotFoundException('生产任务不存在');
            }

            if (task.status !== ProductionTaskStatus.PENDING) {
                throw new BadRequestException('只有“待开始”的任务才能被修改');
            }

            const { startDate, endDate, notes, products } = updateDto;

            if (!products || products.length === 0) {
                throw new BadRequestException('一个生产任务至少需要包含一个产品。');
            }

            await tx.productionTaskItem.deleteMany({
                where: { taskId: id },
            });

            const productIds = products.map((p) => p.productId);

            // [核心修改] 此处检查实时数据，正确
            const existingProducts = await tx.product.findMany({
                where: {
                    id: { in: productIds },
                    recipeVersion: { family: { tenantId } },
                    deletedAt: null, // [核心修改] 确保只选择未被软删除的产品
                },
                include: {
                    recipeVersion: {
                        include: {
                            family: {
                                select: {
                                    deletedAt: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });

            if (existingProducts.length !== productIds.length) {
                throw new NotFoundException('一个或多个目标产品不存在或不属于该店铺。');
            }

            const discontinuedProducts = existingProducts.filter((p) => p.recipeVersion.family.deletedAt !== null);
            if (discontinuedProducts.length > 0) {
                const names = [...new Set(discontinuedProducts.map((p) => p.recipeVersion.family.name))].join('", "');
                throw new BadRequestException(`无法更新任务，因为配方 "${names}" 已被停用。`);
            }

            // [FIX] 移除未使用的 'updatedTask' 变量
            await tx.productionTask.update({
                where: { id },
                data: {
                    startDate,
                    endDate,
                    notes,
                    items: {
                        create: products.map((p) => ({
                            productId: p.productId,
                            quantity: p.quantity,
                        })),
                    },
                },
            });

            // [核心新增] 重新生成并保存快照
            const snapshot = await this._fetchAndSerializeSnapshot(id, tx);
            const taskWithSnapshot = await tx.productionTask.update({
                where: { id },
                data: {
                    recipeSnapshot: snapshot,
                },
                include: taskWithDetailsInclude,
            });

            return this._sanitizeTask(taskWithSnapshot);
        });
    }

    async update(tenantId: string, id: string, updateProductionTaskDto: UpdateProductionTaskDto) {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        return this.prisma.productionTask.update({
            where: { id },
            data: updateProductionTaskDto,
        });
    }

    async remove(tenantId: string, id: string) {
        // [核心修改] 根据新需求调整删除逻辑
        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null, // 确保我们操作的是未删除的任务
            },
            select: {
                status: true,
            },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        // 只有“待开始”的任务才能被删除
        if (task.status !== ProductionTaskStatus.PENDING) {
            throw new BadRequestException(
                `无法删除任务：该任务状态为 ${task.status}。只有“待开始”的任务才能被删除，进行中的任务请使用“取消”操作。`,
            );
        }

        // 执行软删除
        return this.prisma.productionTask.update({
            where: { id },
            data: {
                deletedAt: new Date(),
            },
        });
    }

    async complete(tenantId: string, userId: string, id: string, completeDto: CompleteProductionTaskDto) {
        // [FIX] 修复 ts(2353), 从 include 改为 select
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            // [核心修改] 只需要 items(获取计划数量) 和 recipeSnapshot
            select: {
                items: {
                    select: {
                        productId: true,
                        quantity: true,
                    },
                },
                recipeSnapshot: true,
                status: true, // [FIX] 添加 status 用于检查
                id: true, // [FIX] 添加 id 用于日志
            },
        });

        if (!task) throw new NotFoundException('生产任务不存在');
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
            throw new BadRequestException('只有“待开始”或“进行中”的任务才能被完成');
        }

        // [核心修改] 任务数据*必须*来自快照
        if (!task.recipeSnapshot) {
            throw new BadRequestException(
                '任务数据不完整，缺少配方快照，无法完成任务。请尝试编辑并重新保存任务以生成快照。',
            );
        }
        const snapshot = task.recipeSnapshot as unknown as TaskWithDetails;
        const snapshotProductMap = new Map(snapshot.items.map((i) => [i.product.id, i.product]));

        const { notes, completedItems } = completeDto;

        // [核心重构] 步骤 1: 计算完成和损耗所需的【总投入量】，用于库存检查
        // [核心修改] 此计算*必须*基于快照
        const totalInputNeeded = new Map<string, { name: string; totalConsumed: number }>();
        for (const item of completedItems) {
            const totalQuantity =
                item.completedQuantity + (item.spoilageDetails?.reduce((s, d) => s + d.quantity, 0) || 0);
            if (totalQuantity > 0) {
                const snapshotProduct = snapshotProductMap.get(item.productId);
                if (!snapshotProduct) {
                    throw new BadRequestException(`快照中未找到产品ID ${item.productId}。`);
                }

                // [核心修改] 调用基于快照的新方法 (假设存在)
                const consumptions = await this.costingService.calculateProductConsumptionsFromSnapshot(
                    snapshotProduct,
                    totalQuantity,
                );
                for (const cons of consumptions) {
                    const existing = totalInputNeeded.get(cons.ingredientId);
                    if (existing) {
                        existing.totalConsumed += cons.totalConsumed;
                    } else {
                        totalInputNeeded.set(cons.ingredientId, {
                            name: cons.ingredientName,
                            totalConsumed: cons.totalConsumed,
                        });
                    }
                }
            }
        }

        // 库存检查 (基于“实时”库存，正确)
        const neededIngredientIds = Array.from(totalInputNeeded.keys());
        if (neededIngredientIds.length > 0) {
            const ingredientsInStock = await this.prisma.ingredient.findMany({
                where: { id: { in: neededIngredientIds }, type: IngredientType.STANDARD },
                select: { id: true, name: true, currentStockInGrams: true },
            });
            const stockMap = new Map(ingredientsInStock.map((i) => [i.id, i.currentStockInGrams]));

            const insufficientIngredients: string[] = [];
            for (const [id, needed] of totalInputNeeded.entries()) {
                const currentStock = stockMap.get(id) ?? new Prisma.Decimal(0);
                if (new Prisma.Decimal(currentStock).lt(needed.totalConsumed)) {
                    insufficientIngredients.push(needed.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                throw new BadRequestException(`操作失败：原料库存不足 (${insufficientIngredients.join(', ')})`);
            }
        }

        // [核心重构] 步骤 2: 计算成功生产部分的【理论消耗量】，用于计入产品成本
        // [核心修改] 此计算*必须*基于快照
        const theoreticalConsumption = new Map<
            string,
            { name: string; totalConsumed: number; activeSkuId: string | null }
        >();
        for (const item of completedItems) {
            if (item.completedQuantity > 0) {
                const snapshotProduct = snapshotProductMap.get(item.productId);
                if (!snapshotProduct) {
                    throw new BadRequestException(`快照中未找到产品ID ${item.productId}。`);
                }

                // [核心修改] 调用基于快照的新方法 (假设存在)
                const consumptions = await this.costingService.calculateTheoreticalProductConsumptionsFromSnapshot(
                    snapshotProduct,
                    item.completedQuantity,
                );
                for (const cons of consumptions) {
                    const existing = theoreticalConsumption.get(cons.ingredientId);
                    if (existing) {
                        existing.totalConsumed += cons.totalConsumed;
                    } else {
                        theoreticalConsumption.set(cons.ingredientId, {
                            name: cons.ingredientName,
                            totalConsumed: cons.totalConsumed,
                            activeSkuId: cons.activeSkuId,
                        });
                    }
                }
            }
        }

        // [核心修改] 从 task.items 获取计划数量 (FIX for ts(2339) is above)
        const plannedQuantities = new Map(task.items.map((item) => [item.productId, item.quantity]));

        return this.prisma.$transaction(async (tx) => {
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            // [核心修改] 不再创建快照，只创建日志
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    notes,
                    // recipeSnapshot 字段已移除
                },
            });

            // [核心重构] 步骤 3: 处理显式报损 (Spoilage)
            const totalSpoiledConsumption = new Map<string, Prisma.Decimal>();

            for (const completedItem of completedItems) {
                const { productId, completedQuantity, spoilageDetails } = completedItem;
                const plannedQuantity = plannedQuantities.get(productId);
                // [核心修改] 从快照获取产品名称
                const productName = snapshotProductMap.get(productId)?.name || '未知产品';

                if (plannedQuantity === undefined) {
                    throw new BadRequestException(`产品ID ${productId} 不在任务中。`);
                }

                // 验证上报损耗数量
                const calculatedSpoilage = spoilageDetails?.reduce((sum, s) => sum + s.quantity, 0) || 0;
                // [FIX] 修复 ts(18047)
                const actualSpoilage = Math.max(0, (plannedQuantity || 0) - completedQuantity);
                if (calculatedSpoilage !== actualSpoilage) {
                    throw new BadRequestException(
                        `产品 ${snapshotProductMap.get(productId)?.name} 的损耗数量计算不一致。计划: ${
                            plannedQuantity || 0 // [FIX] 修复 ts(18047)
                        }, 完成: ${completedQuantity}, 上报损耗: ${calculatedSpoilage}，差额应为 ${actualSpoilage}`,
                    );
                }

                if (actualSpoilage > 0 && spoilageDetails) {
                    // [核心修改] 报损消耗同样按“快照”的理论值计算
                    const snapshotProduct = snapshotProductMap.get(productId);
                    if (!snapshotProduct) {
                        throw new BadRequestException(`快照中未找到产品ID ${productId}。`);
                    }
                    const spoiledConsumptions =
                        await this.costingService.calculateTheoreticalProductConsumptionsFromSnapshot(
                            snapshotProduct,
                            actualSpoilage,
                        );

                    for (const spoilage of spoilageDetails) {
                        await tx.productionTaskSpoilageLog.create({
                            data: {
                                productionLogId: productionLog.id,
                                productId,
                                productName: productName,
                                stage: spoilage.stage,
                                quantity: spoilage.quantity,
                                notes: spoilage.notes,
                            },
                        });
                    }

                    for (const cons of spoiledConsumptions) {
                        // [新增] 累计所有报损产品的原料消耗
                        const currentSpoiled = totalSpoiledConsumption.get(cons.ingredientId) || new Prisma.Decimal(0);
                        totalSpoiledConsumption.set(cons.ingredientId, currentSpoiled.add(cons.totalConsumed));

                        await tx.ingredientStockAdjustment.create({
                            data: {
                                ingredientId: cons.ingredientId,
                                userId: userId,
                                changeInGrams: new Prisma.Decimal(-cons.totalConsumed),
                                reason: `生产报损: ${productName}`,
                            },
                        });
                    }
                }

                // 处理超量生产
                // [FIX] 修复 ts(18047)
                const calculatedOverproduction = Math.max(0, completedQuantity - (plannedQuantity || 0));
                if (calculatedOverproduction > 0) {
                    await tx.productionTaskOverproductionLog.create({
                        data: {
                            productionLogId: productionLog.id,
                            productId,
                            productName: productName,
                            quantity: calculatedOverproduction,
                        },
                    });
                }
            }

            // [核心重构] 步骤 4: 根据理论消耗，记录消耗日志并扣减库存（计入COGS）
            const ingredientIdsToUpdate = Array.from(theoreticalConsumption.keys());
            if (ingredientIdsToUpdate.length > 0) {
                const ingredients = await tx.ingredient.findMany({
                    where: { id: { in: ingredientIdsToUpdate }, type: IngredientType.STANDARD },
                    select: { id: true, currentStockInGrams: true, currentStockValue: true },
                });
                const ingredientDataMap = new Map(ingredients.map((i) => [i.id, i]));

                for (const [ingId, cons] of theoreticalConsumption.entries()) {
                    await tx.ingredientConsumptionLog.create({
                        data: {
                            productionLogId: productionLog.id,
                            ingredientId: ingId,
                            skuId: cons.activeSkuId,
                            quantityInGrams: new Prisma.Decimal(cons.totalConsumed),
                        },
                    });

                    const ingredient = ingredientDataMap.get(ingId);
                    if (ingredient) {
                        const decrementAmount = new Prisma.Decimal(cons.totalConsumed);
                        const currentStockValue = new Prisma.Decimal(ingredient.currentStockValue);
                        let valueToDecrement = new Prisma.Decimal(0);
                        if (new Prisma.Decimal(ingredient.currentStockInGrams).gt(0)) {
                            const avgPricePerGram = currentStockValue.div(ingredient.currentStockInGrams);
                            valueToDecrement = avgPricePerGram.mul(decrementAmount);
                        }

                        // 只扣减理论消耗部分
                        await tx.ingredient.update({
                            where: { id: ingId },
                            data: {
                                currentStockInGrams: { decrement: decrementAmount },
                                currentStockValue: { decrement: valueToDecrement },
                            },
                        });
                    }
                }
            }

            // [核心重构] 步骤 5: 计算并处理工艺损耗
            for (const [ingId, inputData] of totalInputNeeded.entries()) {
                const theoreticalData = theoreticalConsumption.get(ingId);
                const theoreticalConsumed = theoreticalData
                    ? new Prisma.Decimal(theoreticalData.totalConsumed)
                    : new Prisma.Decimal(0);

                // [修复] 从总投入中减去成功品的消耗，并且还要减去已经单独扣过库存的报损品的消耗
                const spoiledConsumed = totalSpoiledConsumption.get(ingId) || new Prisma.Decimal(0);
                const processLoss = new Prisma.Decimal(inputData.totalConsumed)
                    .sub(theoreticalConsumed)
                    .sub(spoiledConsumed);

                if (processLoss.gt(0.01)) {
                    // 设置一个阈值避免浮点数误差
                    // 工艺损耗作为一种独立的库存调整被记录
                    await tx.ingredientStockAdjustment.create({
                        data: {
                            ingredientId: ingId,
                            userId: userId,
                            changeInGrams: processLoss.negated(),
                            reason: `工艺损耗: 任务 #${task.id.substring(0, 8)}`,
                        },
                    });
                }
            }

            // [核心修改] 调用 findOne，它现在会从快照读取数据
            return this.findOne(tenantId, id, {});
        });
    }
}
