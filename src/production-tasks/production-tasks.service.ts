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
    RecipeFamily,
    RecipeType,
} from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService, CalculatedRecipeDetails } from '../costing/costing.service';
import { QueryTaskDetailDto } from './dto/query-task-detail.dto';
// [核心新增] 导入为任务详情页重构的DTO
import {
    DoughGroup,
    DoughProductSummary,
    ProductDetails,
    TaskDetailResponseDto,
    TaskIngredientDetail,
} from './dto/task-detail.dto';
// [核心新增] 导入用于修改任务详情的 DTO
import { UpdateTaskDetailsDto } from './dto/update-task-details.dto';

// [核心修改] 将损耗阶段定义移至服务顶部，方便管理
const spoilageStages = [
    { key: 'kneading', label: '打面失败' },
    { key: 'fermentation', label: '发酵失败' },
    { key: 'shaping', label: '整形失败' },
    { key: 'baking', label: '烘烤失败' },
    { key: 'development', label: '新品研发' },
    { key: 'other', label: '其他原因' },
];

export interface PrepTask {
    id: string;
    title: string;
    details: string;
    items: CalculatedRecipeDetails[];
}

// [核心修复] 更新类型定义，使其与 findOne 中的 Prisma 查询完全匹配
const taskWithDetailsInclude = {
    items: {
        include: {
            product: {
                include: {
                    recipeVersion: {
                        include: {
                            family: true,
                            components: {
                                // [核心重命名]
                                include: {
                                    ingredients: {
                                        include: {
                                            ingredient: { include: { activeSku: true } },
                                            linkedPreDough: {
                                                include: {
                                                    versions: {
                                                        where: { isActive: true },
                                                        include: {
                                                            components: {
                                                                // [核心重命名]
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
                            ingredient: { include: { activeSku: true } },
                            linkedExtra: true,
                        },
                    },
                },
            },
        },
    },
    log: {
        select: {
            recipeSnapshot: true,
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
type ComponentWithRecursiveIngredients = ProductWithDetails['recipeVersion']['components'][0]; // [核心重命名]

// [核心修复] 为 prepare task 中的对象定义明确的类型，以消除 'any' 警告
type PrepItemFamily = RecipeFamily;
type RequiredPrepItem = { family: PrepItemFamily; totalWeight: Prisma.Decimal }; // [核心修改] totalWeight to Decimal

// [核心修复] 为扁平化后的原料对象定义明确的类型
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

    // [核心重构] 实现递归的前置任务解析
    private async _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): Promise<PrepTask | null> {
        if (!task || !task.items || task.items.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, RequiredPrepItem>();
        const visitedRecipes = new Set<string>(); // 用于防止无限递归

        // 递归函数，用于解析单个配方的所有依赖
        const resolveDependencies = async (familyId: string, requiredWeight: Prisma.Decimal) => {
            if (visitedRecipes.has(familyId)) return; // 防止循环依赖导致的死循环
            visitedRecipes.add(familyId);

            const recipeFamily = await this.prisma.recipeFamily.findFirst({
                where: { id: familyId, tenantId, deletedAt: null },
                include: {
                    versions: {
                        where: { isActive: true },
                        include: {
                            components: {
                                include: {
                                    ingredients: {
                                        include: {
                                            ingredient: true,
                                            linkedPreDough: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });

            if (!recipeFamily || !recipeFamily.versions[0]?.components[0]) return;

            const activeVersion = recipeFamily.versions[0];
            const mainComponent = activeVersion.components[0];

            const totalRatio = mainComponent.ingredients.reduce(
                (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
                new Prisma.Decimal(0),
            );

            if (totalRatio.isZero()) return;

            const weightPerRatioPoint = requiredWeight.div(totalRatio);

            for (const ing of mainComponent.ingredients) {
                const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                // 如果原料本身是另一个配方 (PRE_DOUGH or EXTRA)，则递归解析
                if (ing.linkedPreDough) {
                    const existing = requiredPrepItems.get(ing.linkedPreDough.id);
                    if (existing) {
                        existing.totalWeight = existing.totalWeight.add(weight);
                    } else {
                        requiredPrepItems.set(ing.linkedPreDough.id, {
                            family: ing.linkedPreDough,
                            totalWeight: weight,
                        });
                    }
                    // 递归深入
                    await resolveDependencies(ing.linkedPreDough.id, weight);
                }
            }
        };

        // 遍历任务中的所有产品，启动第一层依赖解析
        for (const item of task.items) {
            const product = item.product;
            if (!product) continue;

            const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

            // 解析配方组件中的子配方
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
                                .mul(ing.flourRatio)
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

            // 解析产品附加原料中的子配方
            for (const pIng of product.ingredients) {
                if (pIng.linkedExtra) {
                    let weight = new Prisma.Decimal(0);
                    if (pIng.weightInGrams) {
                        weight = new Prisma.Decimal(pIng.weightInGrams).mul(item.quantity);
                    } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                        weight = totalFlourWeight.mul(pIng.ratio).mul(item.quantity);
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
            return null;
        }

        const prepTaskItems: CalculatedRecipeDetails[] = [];
        for (const [id, data] of requiredPrepItems.entries()) {
            const details = await this.costingService.getCalculatedRecipeDetails(
                tenantId,
                id,
                data.totalWeight.toNumber(),
            );
            prepTaskItems.push(details);
        }

        return {
            id: `prep-task-for-${task.id}`,
            title: '备料清单',
            details: `包含 ${prepTaskItems.length} 种预制件`,
            items: prepTaskItems,
        };
    }

    private async _getPrepTask(tenantId: string, date?: string): Promise<PrepTask | null> {
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

        const activeTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: { lte: endOfDay },
                OR: [{ endDate: { gte: startOfDay } }, { endDate: null }],
            },
            include: taskWithDetailsInclude,
        });

        if (activeTasks.length === 0) {
            return null;
        }

        const combinedPrepTask = await this._getPrepItemsForTask(tenantId, {
            ...activeTasks[0], // Use a base task structure
            items: activeTasks.flatMap((task) => task.items), // Combine all items from all tasks
        });

        if (combinedPrepTask) {
            combinedPrepTask.id = 'prep-task-combined';
            combinedPrepTask.title = '前置准备任务';
        }

        return combinedPrepTask;
    }

    async create(tenantId: string, userId: string, createProductionTaskDto: CreateProductionTaskDto) {
        const { startDate, endDate, notes, products } = createProductionTaskDto;

        if (!products || products.length === 0) {
            throw new BadRequestException('一个生产任务至少需要包含一个产品。');
        }

        const productIds = products.map((p) => p.productId);
        const existingProducts = await this.prisma.product.findMany({
            where: {
                id: { in: productIds },
                recipeVersion: { family: { tenantId } },
            },
        });

        if (existingProducts.length !== productIds.length) {
            throw new NotFoundException('一个或多个目标产品不存在或不属于该店铺。');
        }

        const allConsumptions = new Map<
            string,
            { ingredientId: string; ingredientName: string; totalConsumed: number }
        >();
        for (const item of products) {
            const consumptions = await this.costingService.calculateProductConsumptions(
                tenantId,
                item.productId,
                item.quantity,
            );
            for (const consumption of consumptions) {
                const existing = allConsumptions.get(consumption.ingredientId);
                if (existing) {
                    existing.totalConsumed += consumption.totalConsumed;
                } else {
                    allConsumptions.set(consumption.ingredientId, {
                        ingredientId: consumption.ingredientId,
                        ingredientName: consumption.ingredientName,
                        totalConsumed: consumption.totalConsumed,
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

        const createdTask = await this.prisma.productionTask.create({
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
            },
            include: {
                items: {
                    include: {
                        product: true,
                    },
                },
                createdBy: {
                    select: {
                        name: true,
                        phone: true,
                    },
                },
            },
        });

        return { task: createdTask, warning: stockWarning };
    }

    async findActive(tenantId: string, date?: string) {
        const [tasksForDate, dateStats] = await Promise.all([
            this.findTasksForDate(tenantId, date),
            this.getPendingStatsForDate(tenantId, date),
        ]);

        const prepTask = await this._getPrepTask(tenantId, date);

        const inProgressTasks = tasksForDate.filter((task) => task.status === 'IN_PROGRESS');
        const pendingTasks = tasksForDate.filter((task) => task.status === 'PENDING');

        inProgressTasks.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        pendingTasks.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

        const sortedRegularTasks = [...inProgressTasks, ...pendingTasks];

        const combinedTasks: (ProductionTask | (PrepTask & { status: 'PREP' }))[] = [...sortedRegularTasks];
        if (prepTask) {
            combinedTasks.unshift({ ...prepTask, status: 'PREP' });
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
        };

        return this.prisma.productionTask.findMany({
            where,
            include: {
                items: {
                    include: {
                        product: {
                            include: {
                                recipeVersion: {
                                    include: {
                                        family: true,
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
            },
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
            include: {
                items: {
                    include: {
                        product: {
                            include: {
                                recipeVersion: {
                                    include: {
                                        family: true,
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
            },
            orderBy: {
                updatedAt: 'desc',
            },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        const groupedTasks = tasks.reduce((acc: Record<string, ProductionTask[]>, task) => {
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

    async findOne(tenantId: string, id: string, query: QueryTaskDetailDto): Promise<TaskDetailResponseDto> {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: taskWithDetailsInclude,
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        const isCompletedWithSnapshot = task.status === 'COMPLETED' && task.log?.recipeSnapshot;

        const taskDataForCalc = isCompletedWithSnapshot
            ? (task.log!.recipeSnapshot as unknown as TaskWithDetails)
            : task;

        const doughGroups = this._calculateDoughGroups(taskDataForCalc, query, task.items);
        const { stockWarning } = await this._calculateStockWarning(tenantId, task);

        return {
            id: task.id,
            status: task.status,
            notes: task.notes,
            stockWarning,
            prepTask: await this._getPrepItemsForTask(tenantId, task),
            doughGroups,
            items: task.items.map((item) => ({
                id: item.product.id,
                name: item.product.name,
                plannedQuantity: item.quantity,
            })),
        };
    }

    private _calculateDoughGroups(
        task: TaskWithDetails,
        query: QueryTaskDetailDto,
        originalItems: TaskItemWithDetails[],
    ): DoughGroup[] {
        const { mixerType, envTemp, flourTemp, waterTemp } = query;
        const canCalculateIce =
            mixerType !== undefined && envTemp !== undefined && flourTemp !== undefined && waterTemp !== undefined;

        const originalItemsMap = new Map(originalItems.map((item) => [item.productId, item]));

        const doughsMap = new Map<string, { familyName: string; items: TaskItemWithDetails[] }>();
        task.items.forEach((item) => {
            const familyId = item.product.recipeVersion.family.id;
            if (!doughsMap.has(familyId)) {
                doughsMap.set(familyId, {
                    familyName: item.product.recipeVersion.family.name,
                    items: [],
                });
            }
            doughsMap.get(familyId)!.items.push(item);
        });

        const doughGroups: DoughGroup[] = [];
        for (const [familyId, data] of doughsMap.entries()) {
            const firstItem = data.items[0];
            const mainDoughInfo = firstItem.product.recipeVersion.components[0];
            const mainDoughIngredientsMap = new Map<string, TaskIngredientDetail>();
            let totalDoughWeight = new Prisma.Decimal(0);

            let totalFlourForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                const flourPerUnit = this._calculateTotalFlourWeightForProduct(item.product);
                totalFlourForFamily = totalFlourForFamily.add(flourPerUnit.mul(quantity));
            }

            let totalWaterForFamily = new Prisma.Decimal(0);
            let waterIngredientId: string | null = null;
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                const flattened = this._flattenIngredientsForProduct(item.product);
                for (const [, ingData] of flattened.entries()) {
                    if (ingData.waterContent && ingData.waterContent.gt(0)) {
                        const waterWeight = ingData.weight.mul(ingData.waterContent);
                        totalWaterForFamily = totalWaterForFamily.add(waterWeight.mul(quantity));
                    }
                }
            }

            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                const totalFlour = this._calculateTotalFlourWeightForProduct(item.product);
                for (const ing of mainDoughInfo.ingredients) {
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
                        weight = totalFlour.mul(ing.flourRatio).mul(preDoughTotalRatio);
                        id = ing.linkedPreDough.id;
                        name = ing.linkedPreDough.name;
                        isRecipe = true;
                        brand = '自制面种';
                    } else if (ing.ingredient && ing.ratio) {
                        weight = totalFlour.mul(ing.ratio);
                        id = ing.ingredient.id;
                        name = ing.ingredient.name;
                        brand = ing.ingredient.activeSku?.brand || null;

                        if (name === '水') {
                            waterIngredientId = id;
                        }
                    } else {
                        continue;
                    }

                    const currentTotalWeight = weight.mul(quantity);
                    totalDoughWeight = totalDoughWeight.add(currentTotalWeight);

                    const existing = mainDoughIngredientsMap.get(id);
                    if (existing) {
                        existing.weightInGrams += currentTotalWeight.toNumber();
                    } else {
                        const newIngredient: TaskIngredientDetail = {
                            id,
                            name,
                            brand,
                            weightInGrams: currentTotalWeight.toNumber(),
                            isRecipe,
                        };
                        mainDoughIngredientsMap.set(id, newIngredient);
                    }
                }
            }

            if (canCalculateIce && mainDoughInfo.targetTemp && waterIngredientId) {
                const waterIngredient = mainDoughIngredientsMap.get(waterIngredientId);
                if (waterIngredient) {
                    const extraInfoParts: string[] = [];
                    const targetWaterTemp = this._calculateWaterTemp(
                        mainDoughInfo.targetTemp.toNumber(),
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
                        extraInfoParts.push(
                            `需将所有水换成冰块，且其他液体原料需冷却至 ${new Prisma.Decimal(requiredTemp)
                                .toDP(1)
                                .toNumber()}°C`,
                        );
                    } else if (iceWeight > 0) {
                        extraInfoParts.push(`需要替换 ${new Prisma.Decimal(iceWeight).toDP(1).toNumber()}g 冰`);
                    }

                    if (!totalFlourForFamily.isZero()) {
                        const trueHydrationRatio = totalWaterForFamily.div(totalFlourForFamily);
                        if (trueHydrationRatio.gt(0.65)) {
                            const holdBackWater = totalWaterForFamily.sub(totalFlourForFamily.mul(0.65));
                            const holdBackWaterDisplay = holdBackWater.toDP(1);
                            if (holdBackWaterDisplay.gt(0)) {
                                extraInfoParts.push(`需要保留 ${holdBackWaterDisplay.toNumber()}g 水在搅拌过程中加入`);
                            }
                        }
                    }

                    if (extraInfoParts.length > 0) {
                        waterIngredient.extraInfo = extraInfoParts.join('\n');
                    }
                }
            }

            const products: DoughProductSummary[] = [];
            const productDetails: ProductDetails[] = [];
            data.items.forEach((item) => {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                if (quantity === 0) return;

                const { product } = item;
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
                const flattenedProductIngredients = this._flattenIngredientsForProduct(product, false);

                const mixIns: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: totalFlourWeight.mul(ing.ratio ?? 0).toNumber(),
                    }));

                const fillings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'FILLING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: ing.weightInGrams?.toNumber() ?? 0,
                    }));

                const toppings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'TOPPING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: ing.weightInGrams?.toNumber() ?? 0,
                    }));

                const mixInWeightPerUnit = mixIns.reduce((sum, i) => sum.add(i.weightInGrams), new Prisma.Decimal(0));

                const lossRatio = new Prisma.Decimal(mainDoughInfo?.lossRatio || 0);
                const divisor = new Prisma.Decimal(1).sub(lossRatio);
                const adjustedBaseDoughWeight = !divisor.isZero()
                    ? new Prisma.Decimal(product.baseDoughWeight).div(divisor)
                    : new Prisma.Decimal(product.baseDoughWeight);
                const correctedDivisionWeight = adjustedBaseDoughWeight.add(mixInWeightPerUnit);

                products.push({
                    id: product.id,
                    name: product.name,
                    quantity: quantity,
                    totalBaseDoughWeight: new Prisma.Decimal(product.baseDoughWeight).mul(quantity).toNumber(),
                    divisionWeight: correctedDivisionWeight.toNumber(),
                });

                productDetails.push({
                    id: product.id,
                    name: product.name,
                    mixIns: mixIns.map((i) => ({ ...i, weightInGrams: i.weightInGrams * quantity })),
                    fillings: fillings.map((i) => ({ ...i, weightInGrams: i.weightInGrams * quantity })),
                    toppings: toppings.map((i) => ({ ...i, weightInGrams: i.weightInGrams * quantity })),
                    procedure: product.procedure || [],
                });
            });

            doughGroups.push({
                familyId,
                familyName: data.familyName,
                productsDescription: data.items
                    .map((i) => {
                        const originalItem = originalItemsMap.get(i.productId);
                        const quantity = originalItem?.quantity ?? 0;
                        return `${i.product.name} x${quantity}`;
                    })
                    .join(', '),
                totalDoughWeight: totalDoughWeight.toNumber(),
                mainDoughIngredients: Array.from(mainDoughIngredientsMap.values()).sort(
                    (a, b) => (b.isRecipe ? 1 : 0) - (a.isRecipe ? 1 : 0),
                ),
                mainDoughProcedure: mainDoughInfo.procedure || [],
                products,
                productDetails,
            });
        }
        return doughGroups;
    }

    private _flattenIngredientsForProduct(
        product: ProductWithDetails,
        includeDough = true,
    ): Map<string, FlattenedIngredient> {
        const flattened = new Map<string, FlattenedIngredient>();
        const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

        if (includeDough) {
            const processDough = (dough: ComponentWithRecursiveIngredients, flourWeightRef: Prisma.Decimal) => {
                for (const ing of dough.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
                        if (preDoughRecipe) {
                            const flourForPreDough = flourWeightRef.mul(new Prisma.Decimal(ing.flourRatio));
                            processDough(preDoughRecipe as ComponentWithRecursiveIngredients, flourForPreDough);
                        }
                    } else if (ing.ingredient && ing.ratio) {
                        const weight = flourWeightRef.mul(new Prisma.Decimal(ing.ratio));

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
                                waterContent: ing.ingredient.waterContent,
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
                    ratio: pIng.ratio ?? undefined,
                    weightInGrams: pIng.weightInGrams ?? undefined,
                    waterContent: pIng.ingredient.waterContent,
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
                    ratio: pIng.ratio ?? undefined,
                    weightInGrams: pIng.weightInGrams ?? undefined,
                });
            }
        }

        return flattened;
    }

    private _calculateTotalFlourWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        const mainDough = product.recipeVersion.components[0];
        if (!mainDough) return new Prisma.Decimal(0);

        const lossRatio = new Prisma.Decimal(mainDough.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);
        if (divisor.isZero() || divisor.isNegative()) return new Prisma.Decimal(0);
        const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

        const calculateTotalRatio = (dough: ComponentWithRecursiveIngredients): Prisma.Decimal => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions.find((v) => v.isActive)?.components[0];
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

        const totalRatio = calculateTotalRatio(mainDough);
        if (totalRatio.isZero()) return new Prisma.Decimal(0);

        return adjustedDoughWeight.div(totalRatio);
    }

    private async _calculateStockWarning(tenantId: string, task: TaskWithDetails) {
        const totalIngredientsMap = new Map<string, { name: string; totalWeight: number }>();
        await Promise.all(
            task.items.map(async (item) => {
                const consumptions = await this.costingService.calculateProductConsumptions(
                    tenantId,
                    item.productId,
                    item.quantity,
                );
                for (const consumption of consumptions) {
                    const existing = totalIngredientsMap.get(consumption.ingredientId);
                    if (existing) {
                        existing.totalWeight += consumption.totalConsumed;
                    } else {
                        totalIngredientsMap.set(consumption.ingredientId, {
                            name: consumption.ingredientName,
                            totalWeight: consumption.totalConsumed,
                        });
                    }
                }
            }),
        );

        let stockWarning: string | null = null;
        const ingredientIds = Array.from(totalIngredientsMap.keys());
        if (ingredientIds.length > 0) {
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
            const existingProducts = await tx.product.findMany({
                where: {
                    id: { in: productIds },
                    recipeVersion: { family: { tenantId } },
                },
            });

            if (existingProducts.length !== productIds.length) {
                throw new NotFoundException('一个或多个目标产品不存在或不属于该店铺。');
            }

            const updatedTask = await tx.productionTask.update({
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
                include: {
                    items: {
                        include: {
                            product: true,
                        },
                    },
                    createdBy: {
                        select: {
                            name: true,
                            phone: true,
                        },
                    },
                },
            });
            return updatedTask;
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
        await this.findOne(tenantId, id, {});
        return this.prisma.productionTask.update({
            where: { id },
            data: {
                deletedAt: new Date(),
            },
        });
    }

    async complete(tenantId: string, userId: string, id: string, completeDto: CompleteProductionTaskDto) {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: taskWithDetailsInclude,
        });

        if (!task) throw new NotFoundException('生产任务不存在');
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
            throw new BadRequestException('只有“待开始”或“进行中”的任务才能被完成');
        }

        const { notes, completedItems } = completeDto;

        const totalConsumptionNeeded = new Map<string, { name: string; totalConsumed: number }>();
        for (const item of completedItems) {
            if (item.completedQuantity > 0) {
                const consumptions = await this.costingService.calculateProductConsumptions(
                    tenantId,
                    item.productId,
                    item.completedQuantity,
                );
                for (const cons of consumptions) {
                    const existing = totalConsumptionNeeded.get(cons.ingredientId);
                    if (existing) {
                        existing.totalConsumed += cons.totalConsumed;
                    } else {
                        totalConsumptionNeeded.set(cons.ingredientId, {
                            name: cons.ingredientName,
                            totalConsumed: cons.totalConsumed,
                        });
                    }
                }
            }
        }

        const neededIngredientIds = Array.from(totalConsumptionNeeded.keys());
        if (neededIngredientIds.length > 0) {
            const ingredientsInStock = await this.prisma.ingredient.findMany({
                where: { id: { in: neededIngredientIds }, type: IngredientType.STANDARD },
                select: { id: true, currentStockInGrams: true },
            });
            const stockMap = new Map(ingredientsInStock.map((i) => [i.id, i.currentStockInGrams]));

            const insufficientIngredients: string[] = [];
            for (const [id, needed] of totalConsumptionNeeded.entries()) {
                const currentStock = stockMap.get(id) ?? new Prisma.Decimal(0);
                if (new Prisma.Decimal(currentStock).lt(needed.totalConsumed)) {
                    insufficientIngredients.push(needed.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                throw new BadRequestException(`操作失败：原料库存不足 (${insufficientIngredients.join(', ')})`);
            }
        }

        const plannedQuantities = new Map(task.items.map((item) => [item.productId, item.quantity]));

        return this.prisma.$transaction(async (tx) => {
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            const recipeSnapshot = this._buildRecipeSnapshot(task);
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    notes,
                    recipeSnapshot,
                },
            });

            const totalSuccessfulConsumption = new Map<string, { totalConsumed: number; activeSkuId: string | null }>();
            for (const [ingId, data] of totalConsumptionNeeded.entries()) {
                const ingredientInfo = await tx.ingredient.findUnique({
                    where: { id: ingId },
                    select: { activeSkuId: true },
                });
                totalSuccessfulConsumption.set(ingId, {
                    totalConsumed: data.totalConsumed,
                    activeSkuId: ingredientInfo?.activeSkuId || null,
                });
            }

            for (const completedItem of completedItems) {
                const { productId, completedQuantity, spoilageDetails } = completedItem;
                const plannedQuantity = plannedQuantities.get(productId);

                if (plannedQuantity === undefined) {
                    throw new BadRequestException(`产品ID ${productId} 不在任务中。`);
                }

                const calculatedSpoilage = spoilageDetails?.reduce((sum, s) => sum + s.quantity, 0) || 0;
                const calculatedOverproduction = Math.max(0, completedQuantity - plannedQuantity);
                const actualSpoilage = Math.max(0, plannedQuantity - completedQuantity);

                if (calculatedSpoilage !== actualSpoilage) {
                    throw new BadRequestException(
                        `产品 ${productId} 的损耗数量计算不一致。计划: ${plannedQuantity}, 完成: ${completedQuantity}, 上报损耗: ${calculatedSpoilage}`,
                    );
                }

                if (actualSpoilage > 0 && spoilageDetails) {
                    const spoiledConsumptions = await this.costingService.calculateProductConsumptions(
                        tenantId,
                        productId,
                        actualSpoilage,
                    );

                    for (const spoilage of spoilageDetails) {
                        await tx.productionTaskSpoilageLog.create({
                            data: {
                                productionLogId: productionLog.id,
                                productId,
                                stage: spoilage.stage,
                                quantity: spoilage.quantity,
                                notes: spoilage.notes,
                            },
                        });
                    }

                    for (const cons of spoiledConsumptions) {
                        const productName =
                            task.items.find((i) => i.productId === productId)?.product.name || '未知产品';
                        await tx.ingredientStockAdjustment.create({
                            data: {
                                ingredientId: cons.ingredientId,
                                userId: userId,
                                changeInGrams: -cons.totalConsumed,
                                reason: `生产损耗: ${productName}`,
                            },
                        });
                    }
                }

                if (calculatedOverproduction > 0) {
                    await tx.productionTaskOverproductionLog.create({
                        data: {
                            productionLogId: productionLog.id,
                            productId,
                            quantity: calculatedOverproduction,
                        },
                    });
                }
            }

            const ingredientIds = Array.from(totalSuccessfulConsumption.keys());
            if (ingredientIds.length > 0) {
                const ingredients = await tx.ingredient.findMany({
                    where: { id: { in: ingredientIds } },
                    select: { id: true, currentStockInGrams: true, currentStockValue: true },
                });
                const ingredientDataMap = new Map(ingredients.map((i) => [i.id, i]));

                for (const [ingId, cons] of totalSuccessfulConsumption.entries()) {
                    await tx.ingredientConsumptionLog.create({
                        data: {
                            productionLogId: productionLog.id,
                            ingredientId: ingId,
                            skuId: cons.activeSkuId,
                            quantityInGrams: cons.totalConsumed,
                        },
                    });

                    const ingredient = ingredientDataMap.get(ingId);
                    if (ingredient) {
                        const decrementAmount = new Prisma.Decimal(cons.totalConsumed);
                        const currentStockValue = new Prisma.Decimal(ingredient.currentStockValue.toString());
                        let valueToDecrement = new Prisma.Decimal(0);
                        if (new Prisma.Decimal(ingredient.currentStockInGrams).gt(0)) {
                            const avgPricePerGram = currentStockValue.div(ingredient.currentStockInGrams);
                            valueToDecrement = avgPricePerGram.mul(decrementAmount);
                        }

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

            return this.findOne(tenantId, id, {});
        });
    }

    private _buildRecipeSnapshot(task: TaskWithDetails): Prisma.JsonObject {
        const snapshot = {
            items: task.items,
        };

        return snapshot as unknown as Prisma.JsonObject;
    }
}
