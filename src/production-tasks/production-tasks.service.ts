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

// [核心修复] 更新类型定义，使其与 findOne 中的 Prisma 查询完全匹配，特别是对 linkedPreDough 的深度嵌套
const taskWithDetailsInclude = {
    items: {
        include: {
            product: {
                include: {
                    recipeVersion: {
                        include: {
                            family: true,
                            doughs: {
                                include: {
                                    ingredients: {
                                        include: {
                                            ingredient: { include: { activeSku: true } },
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
                            ingredient: { include: { activeSku: true } },
                            linkedExtra: true,
                        },
                    },
                },
            },
        },
    },
    // [核心修正] 将关联字段名从 productionLog 改为 log，以匹配 schema.prisma 定义
    log: {
        select: {
            recipeSnapshot: true,
        },
    },
};

type TaskWithDetails = Prisma.ProductionTaskGetPayload<{
    include: typeof taskWithDetailsInclude;
}>;

type TaskItemWithDetails = TaskWithDetails['items'][0];
type ProductWithDetails = TaskItemWithDetails['product'];
type DoughWithRecursiveIngredients = ProductWithDetails['recipeVersion']['doughs'][0];

// [核心修复] 为 prepare task 中的对象定义明确的类型，以消除 'any' 警告
type PrepItemFamily = RecipeFamily;
type RequiredPrepItem = { family: PrepItemFamily; totalWeight: number };

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
    ratio?: number;
    weightInGrams?: number;
    waterContent?: number; // [核心修改] 新增含水量字段，用于精确计算总水量
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
        // [FIX] 移除 Math.round()，保留计算精度，避免将小于0.5的数值归零
        return ice;
    }

    /**
     * [核心新增] 反向计算当所有水都换成冰块时，其他液体原料需要达到的温度
     * (New: Reverse calculate the required temperature for other liquid ingredients when all water is replaced by ice)
     * @param targetWaterTemp 目标水温 (摄氏度)
     * @param totalRecipeWater 配方总水量 (克)
     * @param availableWaterToReplace 可用于替换成冰的水量 (克)
     * @returns 其他液体原料需要达到的温度 (摄氏度)
     */
    private _calculateRequiredWetIngredientTemp(
        targetWaterTemp: number,
        totalRecipeWater: number,
        availableWaterToReplace: number,
    ): number {
        // 公式 T_required = (-TotalWater * T_targetWater - 80 * AllAvailableWater) / (AllAvailableWater - TotalWater)
        // 该公式确保即使总水量为0，也不会出现除以0的错误
        if (availableWaterToReplace - totalRecipeWater === 0) {
            return 0; // 或者一个合理的默认值
        }
        return (
            (-totalRecipeWater * targetWaterTemp - 80 * availableWaterToReplace) /
            (availableWaterToReplace - totalRecipeWater)
        );
    }

    private async _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): Promise<PrepTask | null> {
        if (!task || !task.items || task.items.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, RequiredPrepItem>();

        for (const item of task.items) {
            const product = item.product;
            if (!product) continue;

            const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

            for (const dough of product.recipeVersion.doughs) {
                for (const ing of dough.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
                        if (preDoughRecipe) {
                            const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                                (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                                new Prisma.Decimal(0),
                            );
                            const weight = totalFlourWeight
                                .mul(ing.flourRatio)
                                .mul(preDoughTotalRatio)
                                .mul(item.quantity)
                                .toNumber();

                            const existing = requiredPrepItems.get(ing.linkedPreDough.id);
                            if (existing) {
                                existing.totalWeight += weight;
                            } else {
                                requiredPrepItems.set(ing.linkedPreDough.id, {
                                    family: ing.linkedPreDough,
                                    totalWeight: weight,
                                });
                            }
                        }
                    }
                }
            }

            for (const pIng of product.ingredients) {
                if (pIng.linkedExtra) {
                    let weight = 0;
                    if (pIng.weightInGrams) {
                        weight = pIng.weightInGrams * item.quantity;
                    } else if (pIng.ratio) {
                        weight = totalFlourWeight.mul(pIng.ratio).mul(item.quantity).toNumber();
                    }
                    const existing = requiredPrepItems.get(pIng.linkedExtra.id);
                    if (existing) {
                        existing.totalWeight += weight;
                    } else {
                        requiredPrepItems.set(pIng.linkedExtra.id, {
                            family: pIng.linkedExtra,
                            totalWeight: weight,
                        });
                    }
                }
            }
        }

        if (requiredPrepItems.size === 0) {
            return null;
        }

        const prepTaskItems: CalculatedRecipeDetails[] = [];
        for (const [id, data] of requiredPrepItems.entries()) {
            const details = await this.costingService.getCalculatedRecipeDetails(tenantId, id, data.totalWeight);
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
            // [核心修复] 调整了日期验证逻辑，以兼容小程序可能传来的无效日期字符串
            // 如果解析出的日期无效（例如，当 date 是 ''、'undefined' 或 'null' 时），
            // 则静默地回退到使用当前日期，而不是抛出错误，从而提高接口的容错性。
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        // [核心修复] 创建新的Date对象，避免对 targetDate 的重复修改
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

        const requiredPrepItems = new Map<string, RequiredPrepItem>();

        for (const task of activeTasks) {
            for (const item of task.items) {
                const product = item.product;
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

                for (const dough of product.recipeVersion.doughs) {
                    for (const ing of dough.ingredients) {
                        if (ing.linkedPreDough && ing.flourRatio) {
                            const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
                            if (preDoughRecipe) {
                                const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                                    (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                                    new Prisma.Decimal(0),
                                );
                                const weight = totalFlourWeight
                                    .mul(ing.flourRatio)
                                    .mul(preDoughTotalRatio)
                                    .mul(item.quantity)
                                    .toNumber();

                                const existing = requiredPrepItems.get(ing.linkedPreDough.id);
                                if (existing) {
                                    existing.totalWeight += weight;
                                } else {
                                    requiredPrepItems.set(ing.linkedPreDough.id, {
                                        family: ing.linkedPreDough,
                                        totalWeight: weight,
                                    });
                                }
                            }
                        }
                    }
                }

                for (const pIng of product.ingredients) {
                    if (pIng.linkedExtra) {
                        let weight = 0;
                        if (pIng.weightInGrams) {
                            weight = pIng.weightInGrams * item.quantity;
                        } else if (pIng.ratio) {
                            weight = totalFlourWeight.mul(pIng.ratio).mul(item.quantity).toNumber();
                        }
                        const existing = requiredPrepItems.get(pIng.linkedExtra.id);
                        if (existing) {
                            existing.totalWeight += weight;
                        } else {
                            requiredPrepItems.set(pIng.linkedExtra.id, {
                                family: pIng.linkedExtra,
                                totalWeight: weight,
                            });
                        }
                    }
                }
            }
        }

        if (requiredPrepItems.size === 0) {
            return null;
        }

        const prepTaskItems: CalculatedRecipeDetails[] = [];
        for (const [id, data] of requiredPrepItems.entries()) {
            const details = await this.costingService.getCalculatedRecipeDetails(tenantId, id, data.totalWeight);
            prepTaskItems.push(details);
        }

        return {
            id: 'prep-task-01',
            title: '前置准备任务',
            details: `包含 ${prepTaskItems.length} 种预制件`,
            items: prepTaskItems,
        };
    }

    async create(tenantId: string, createProductionTaskDto: CreateProductionTaskDto) {
        // [修改] 解构出 startDate 和 endDate
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
                if (ingredient && ingredient.currentStockInGrams < consumption.totalConsumed) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }

        const createdTask = await this.prisma.productionTask.create({
            data: {
                startDate, // [修改] 使用 startDate
                endDate, // [修改] 使用 endDate
                notes,
                tenantId,
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
            },
        });

        return { task: createdTask, warning: stockWarning };
    }

    async findActive(tenantId: string, date?: string) {
        // [核心修改] 将对 getTodaysPendingStats 的调用改为 getPendingStatsForDate，并传入日期
        const [tasksForDate, dateStats] = await Promise.all([
            this.findTasksForDate(tenantId, date),
            this.getPendingStatsForDate(tenantId, date),
        ]);

        const prepTask = await this._getPrepTask(tenantId, date);

        // [核心重构] 在后端对常规任务进行排序
        const inProgressTasks = tasksForDate.filter((task) => task.status === 'IN_PROGRESS');
        const pendingTasks = tasksForDate.filter((task) => task.status === 'PENDING');

        // 进行中任务按开始日期降序
        inProgressTasks.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        // 待开始任务按开始日期升序
        pendingTasks.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

        const sortedRegularTasks = [...inProgressTasks, ...pendingTasks];

        // [核心重构] 在后端合并任务列表
        const combinedTasks: (ProductionTask | (PrepTask & { status: 'PREP' }))[] = [...sortedRegularTasks];
        if (prepTask) {
            // 将 prepTask 转换为与 ProductionTaskDto 兼容的结构并插入到列表开头
            combinedTasks.unshift({ ...prepTask, status: 'PREP' });
        }

        return {
            stats: dateStats, // [核心修改] 返回新的统计数据
            // [核心修改] tasks 字段现在是包含 prepTask (如果存在) 并已排序的完整列表
            tasks: combinedTasks,
            // [核心修改] prepTask 字段不再单独返回，将其设为 null 以保持 API 结构一致性
            prepTask: null,
        };
    }

    /**
     * @description [核心新增] 这是一个内部辅助函数，用于查询指定日期的任务
     * @param tenantId 租户ID
     * @param date 日期字符串
     * @returns 返回任务列表
     */
    private async findTasksForDate(tenantId: string, date?: string) {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            // [核心修复] 调整了日期验证逻辑，以兼容小程序可能传来的无效日期字符串
            // 如果解析出的日期无效（例如，当 date 是 ''、'undefined' 或 'null' 时），
            // 则静默地回退到使用当前日期，而不是抛出错误，从而提高接口的容错性。
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        // [核心修复] 创建新的Date对象副本进行修改，避免污染原始的targetDate对象
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
            },
            orderBy: {
                startDate: 'asc',
            },
        });
    }

    /**
     * @description [核心修改] 此函数现在根据传入的日期计算待完成任务总数
     * @param tenantId 租户ID
     * @param date 'YYYY-MM-DD' 格式的日期字符串 (可选)
     * @returns 返回包含指定日期待完成数量的对象
     */
    private async getPendingStatsForDate(tenantId: string, date?: string) {
        // [核心修改] 使用与 findTasksForDate 相同的逻辑来确定目标日期
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
                // [核心修改] 使用目标日期的开始和结束时间进行过滤
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
            // [核心改造] 将 todayPendingCount 重命名为 pendingCount
            pendingCount: pendingCount,
        };
    }

    /**
     * [新增] 获取所有任务的日期
     * @param tenantId
     * @returns
     */
    async getTaskDates(tenantId: string) {
        const tasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                // [核心修复] 同时排除已完成和已取消的任务
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
            // [修改] 将 let 改为 const 以修复 eslint 警告
            const current = new Date(task.startDate);
            const end = task.endDate ? new Date(task.endDate) : new Date(task.startDate);

            // 确保我们将日期设置为午夜，以避免时区问题
            current.setUTCHours(0, 0, 0, 0);
            end.setUTCHours(0, 0, 0, 0);

            while (current <= end) {
                dates.add(current.toISOString().split('T')[0]);
                current.setDate(current.getDate() + 1);
            }
        });

        return Array.from(dates);
    }

    // [核心新增] 获取损耗阶段列表
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
            },
            // [核心修改] 将排序字段从 startDate 改为 updatedAt，以反映真实的完成/取消时间
            orderBy: {
                updatedAt: 'desc',
            },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        // [核心重构] 在服务端完成分组逻辑
        const groupedTasks = tasks.reduce(
            (acc: Record<string, ProductionTask[]>, task) => {
                // [核心修改] 分组的日期依据也改为 updatedAt
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
            },
            {}, // 初始值为空对象
        );

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

    // [核心重构] 将 findOne 拆分为多个更小的、可管理的私有方法
    async findOne(tenantId: string, id: string, query: QueryTaskDetailDto): Promise<TaskDetailResponseDto> {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: taskWithDetailsInclude,
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        // [核心改造] 如果是已完成任务且有快照，则使用快照数据；否则使用实时数据
        // [核心修正] 将关联字段名从 task.productionLog 改为 task.log，以匹配 schema.prisma 定义
        const isCompletedWithSnapshot = task.status === 'COMPLETED' && task.log?.recipeSnapshot;

        const taskDataForCalc = isCompletedWithSnapshot
            ? // [核心修正] 使用非空断言(!)来告诉TypeScript，在此上下文中task.log必然存在
              (task.log!.recipeSnapshot as unknown as TaskWithDetails)
            : task;

        // [核心改造] 将用于计算的数据源 (实时或快照) 传递给计算函数
        const doughGroups = this._calculateDoughGroups(taskDataForCalc, query, task.items);
        const { stockWarning } = await this._calculateStockWarning(tenantId, task);

        return {
            id: task.id,
            status: task.status,
            notes: task.notes,
            stockWarning,
            prepTask: await this._getPrepItemsForTask(tenantId, task), // 备料任务总是基于实时数据
            doughGroups,
            items: task.items.map((item) => ({
                id: item.product.id,
                name: item.product.name,
                plannedQuantity: item.quantity,
            })),
        };
    }

    /**
     * @description [核心重构] 恢复并优化了递归逻辑，以正确展示面种及其原料
     * @param task [核心改造] 此参数现在可以是实时的任务数据，也可以是历史快照数据
     * @param query 查询参数
     * @param originalItems [核心新增] 总是传入原始的任务项以获取正确的计划生产数量
     */
    private _calculateDoughGroups(
        task: TaskWithDetails,
        query: QueryTaskDetailDto,
        originalItems: TaskItemWithDetails[],
    ): DoughGroup[] {
        const { mixerType, envTemp, flourTemp, waterTemp } = query;
        const canCalculateIce =
            mixerType !== undefined && envTemp !== undefined && flourTemp !== undefined && waterTemp !== undefined;

        // [核心改造] 创建一个从 productId 到原始任务项的映射，以便随时获取计划数量
        const originalItemsMap = new Map(originalItems.map((item) => [item.productId, item]));

        const doughsMap = new Map<string, { familyName: string; items: TaskItemWithDetails[] }>();
        // [核心改造] 这里的 task.items 可能来自快照，也可能来自实时数据
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
            const mainDoughInfo = firstItem.product.recipeVersion.doughs[0];
            const mainDoughIngredientsMap = new Map<string, TaskIngredientDetail>();
            let totalDoughWeight = new Prisma.Decimal(0);

            // [核心新增] 为后加水逻辑计算面团家族的总面粉量
            let totalFlourForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0; // [核心改造] 使用原始计划数量
                const flourPerUnit = this._calculateTotalFlourWeightForProduct(item.product);
                totalFlourForFamily = totalFlourForFamily.add(flourPerUnit.mul(quantity));
            }

            // [核心修改] 采用与 cal.js 一致的精确总水量计算逻辑
            let totalWaterForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0; // [核心改造] 使用原始计划数量
                const flattened = this._flattenIngredientsForProduct(item.product);
                for (const [, ingData] of flattened.entries()) {
                    // 检查原料是否定义了含水量，并且大于0
                    if (ingData.waterContent && ingData.waterContent > 0) {
                        // 计算该原料的实际水重（原料总重 * 含水比例）
                        const waterWeight = ingData.weight.mul(new Prisma.Decimal(ingData.waterContent));
                        // 累加到家族总水量中，并乘以产品数量
                        totalWaterForFamily = totalWaterForFamily.add(waterWeight.mul(quantity));
                    }
                }
            }

            // [核心恢复] 遍历原始配方结构以建立包含面种的原料列表
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0; // [核心改造] 使用原始计划数量
                const totalFlour = this._calculateTotalFlourWeightForProduct(item.product);
                for (const ing of mainDoughInfo.ingredients) {
                    let weight: Prisma.Decimal;
                    let id: string;
                    let name: string;
                    let brand: string | null = null;
                    let isRecipe = false;
                    let extraInfo: string | null = null;

                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
                        if (!preDoughRecipe) continue;

                        const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        weight = totalFlour.mul(ing.flourRatio).mul(preDoughTotalRatio);
                        id = ing.linkedPreDough.id;
                        name = ing.linkedPreDough.name;
                        isRecipe = true;
                    } else if (ing.ingredient && ing.ratio) {
                        weight = totalFlour.mul(ing.ratio);
                        id = ing.ingredient.id;
                        name = ing.ingredient.name;
                        brand = ing.ingredient.activeSku?.brand || null;
                    } else {
                        continue;
                    }

                    const currentWaterWeight = weight.mul(quantity);
                    totalDoughWeight = totalDoughWeight.add(currentWaterWeight);

                    // [核心修改] 增强用冰量计算逻辑
                    if (canCalculateIce && name === '水' && mainDoughInfo.targetTemp) {
                        const extraInfoParts: string[] = [];

                        const targetWaterTemp = this._calculateWaterTemp(
                            mainDoughInfo.targetTemp,
                            mixerType,
                            flourTemp,
                            envTemp,
                        );
                        const iceWeight = this._calculateIce(
                            targetWaterTemp,
                            totalWaterForFamily.toNumber(),
                            waterTemp,
                        );

                        // [逻辑整合] 检查所需冰量是否超过可用水量
                        if (iceWeight > currentWaterWeight.toNumber()) {
                            // [逻辑整合] 如果超过，则反向计算其他液体原料所需温度
                            const requiredTemp = this._calculateRequiredWetIngredientTemp(
                                targetWaterTemp,
                                totalWaterForFamily.toNumber(),
                                currentWaterWeight.toNumber(),
                            );
                            extraInfoParts.push(
                                `需将所有水换成冰块，且其他液体原料需冷却至 ${new Prisma.Decimal(requiredTemp)
                                    .toDP(1)
                                    .toNumber()}°C`,
                            );
                        } else if (iceWeight > 0) {
                            // [逻辑整合] 如果未超过，则按原逻辑提示替换冰块
                            extraInfoParts.push(`需要替换 ${new Prisma.Decimal(iceWeight).toDP(1).toNumber()}g 冰`);
                        }

                        // 后加水逻辑保持不变
                        if (!totalFlourForFamily.isZero()) {
                            const trueHydrationRatio = totalWaterForFamily.div(totalFlourForFamily);
                            if (trueHydrationRatio.gt(0.65)) {
                                const holdBackWater = totalWaterForFamily.sub(totalFlourForFamily.mul(0.65));
                                extraInfoParts.push(`需要保留 ${holdBackWater.toDP(1).toNumber()}g 水在搅拌过程中加入`);
                            }
                        }

                        if (extraInfoParts.length > 0) {
                            extraInfo = extraInfoParts.join('\n');
                        }
                    }

                    const existing = mainDoughIngredientsMap.get(id);
                    if (existing) {
                        existing.weightInGrams += currentWaterWeight.toNumber();
                    } else {
                        const newIngredient: TaskIngredientDetail = {
                            id,
                            name,
                            brand,
                            weightInGrams: currentWaterWeight.toNumber(),
                            isRecipe,
                        };

                        if (extraInfo) {
                            newIngredient.extraInfo = extraInfo;
                        }

                        mainDoughIngredientsMap.set(id, newIngredient);
                    }
                }
            }

            const products: DoughProductSummary[] = [];
            const productDetails: ProductDetails[] = [];
            data.items.forEach((item) => {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0; // [核心改造] 使用原始计划数量
                if (quantity === 0) return; // 如果计划数量为0，则跳过

                const { product } = item;
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
                const flattenedProductIngredients = this._flattenIngredientsForProduct(product, false);

                const mixIns: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: totalFlourWeight.mul(ing.ratio ?? 0).toNumber(),
                    }));

                const fillings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'FILLING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: ing.weightInGrams ?? 0,
                    }));

                const toppings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'TOPPING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: ing.weightInGrams ?? 0,
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
                    totalBaseDoughWeight: product.baseDoughWeight * quantity,
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
                // [核心改造] 对主面团原料进行排序，将面种类（isRecipe: true）的原料置于列表顶部
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
            const processDough = (dough: DoughWithRecursiveIngredients, flourWeightRef: Prisma.Decimal) => {
                for (const ing of dough.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
                        if (preDoughRecipe) {
                            const flourForPreDough = flourWeightRef.mul(new Prisma.Decimal(ing.flourRatio));
                            processDough(preDoughRecipe as DoughWithRecursiveIngredients, flourForPreDough);
                        }
                    } else if (ing.ingredient && ing.ratio) {
                        const weight = flourWeightRef.mul(new Prisma.Decimal(ing.ratio));

                        // [核心修复] 从“覆盖”逻辑改为“累加”逻辑
                        const existing = flattened.get(ing.ingredient.id);
                        if (existing) {
                            // 如果原料已存在于列表中（例如，在主面团和面种中都存在），则累加其重量
                            existing.weight = existing.weight.add(weight);
                        } else {
                            // 如果是第一次遇到该原料，则将其添加到列表
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
            processDough(product.recipeVersion.doughs[0], totalFlourWeight);
        }

        for (const pIng of product.ingredients) {
            if (pIng.ingredient) {
                flattened.set(pIng.ingredient.id, {
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
                flattened.set(pIng.linkedExtra.id, {
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
        const mainDough = product.recipeVersion.doughs[0];
        if (!mainDough) return new Prisma.Decimal(0);

        const lossRatio = new Prisma.Decimal(mainDough.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);
        if (divisor.isZero() || divisor.isNegative()) return new Prisma.Decimal(0);
        const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

        const calculateTotalRatio = (dough: DoughWithRecursiveIngredients): Prisma.Decimal => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
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
                if (ingredient && ingredient.currentStockInGrams < data.totalWeight) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }
        return { stockWarning };
    }

    async update(tenantId: string, id: string, updateProductionTaskDto: UpdateProductionTaskDto) {
        await this.findOne(tenantId, id, {});
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

    // [核心重构] complete 方法的整体逻辑
    async complete(tenantId: string, userId: string, id: string, completeDto: CompleteProductionTaskDto) {
        // [核心改造] 查询任务时，使用包含完整配方数据的 taskWithDetailsInclude
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: taskWithDetailsInclude,
        });

        if (!task) throw new NotFoundException('生产任务不存在');
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
            throw new BadRequestException('只有“待开始”或“进行中”的任务才能被完成');
        }

        const { notes, completedItems } = completeDto;

        // [核心新增] 开始：在所有操作之前进行严格的库存检查
        // 1. 计算本次完成所有产品所需的原料总量
        const totalConsumptionNeeded = new Map<string, { name: string; totalConsumed: number }>();
        for (const item of completedItems) {
            // 只计算实际生产了的产品
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
            // 2. 获取这些原料的当前库存
            const ingredientsInStock = await this.prisma.ingredient.findMany({
                where: { id: { in: neededIngredientIds }, type: IngredientType.STANDARD }, // 只检查需要追踪的原料
                select: { id: true, currentStockInGrams: true },
            });
            const stockMap = new Map(ingredientsInStock.map((i) => [i.id, i.currentStockInGrams]));

            // 3. 比较需求量和库存量，找出所有库存不足的原料
            const insufficientIngredients: string[] = [];
            for (const [id, needed] of totalConsumptionNeeded.entries()) {
                const currentStock = stockMap.get(id) ?? 0;
                if (currentStock < needed.totalConsumed) {
                    insufficientIngredients.push(needed.name);
                }
            }

            // 4. 如果有任何原料不足，则抛出异常，终止操作
            if (insufficientIngredients.length > 0) {
                throw new BadRequestException(`操作失败：原料库存不足 (${insufficientIngredients.join(', ')})`);
            }
        }
        // [核心新增] 结束：库存检查完毕

        const plannedQuantities = new Map(task.items.map((item) => [item.productId, item.quantity]));

        return this.prisma.$transaction(async (tx) => {
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            // [核心改造] 在创建生产日志时，生成并存入配方快照
            const recipeSnapshot = this._buildRecipeSnapshot(task);
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    notes,
                    recipeSnapshot, // 存入快照
                },
            });

            // [核心修改] totalSuccessfulConsumption 现在可以直接使用上面库存检查时计算好的 totalConsumptionNeeded
            const totalSuccessfulConsumption = new Map<string, { totalConsumed: number; activeSkuId: string | null }>();
            for (const [ingId, data] of totalConsumptionNeeded.entries()) {
                // 需要补充 activeSkuId
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
                        // 因为已经在前面检查过库存，这里的扣减是安全的
                        const decrementAmount = cons.totalConsumed;
                        const currentStockValue = new Prisma.Decimal(ingredient.currentStockValue.toString());
                        let valueToDecrement = new Prisma.Decimal(0);
                        if (ingredient.currentStockInGrams > 0) {
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

    /**
     * [核心新增] 根据完整的任务数据构建一个用于归档的配方快照
     * @param task 从数据库中查询到的，包含了完整 recipeVersion 信息的任务对象
     * @returns 一个 JSON 对象，其结构与 TaskWithDetails 兼容
     */
    private _buildRecipeSnapshot(task: TaskWithDetails): Prisma.JsonObject {
        // 创建一个深拷贝，移除不必要的循环引用或敏感信息
        // 在这个场景下，task 对象已经是从数据库获取的纯数据，可以直接使用
        // 我们只保留 items 数组，因为其他任务信息 (id, status, notes) 已经存储在任务表本身
        const snapshot = {
            items: task.items,
        };

        // Prisma.JsonObject 要求返回一个可以被 JSON.stringify 的对象
        return snapshot as unknown as Prisma.JsonObject;
    }
}
