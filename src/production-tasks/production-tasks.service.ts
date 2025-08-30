import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import { IngredientType, Prisma, ProductionTask, ProductionTaskStatus, RecipeType } from '@prisma/client'; // [修改] 移除了未使用的 'Dough' 导入
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

// [核心新增] 定义损耗阶段的中英文映射
const stageToChineseMap: Record<string, string> = {
    kneading: '揉面失败',
    fermentation: '发酵失败',
    shaping: '整形失败',
    baking: '烘烤失败',
    other: '其他原因',
};

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
};

type TaskWithDetails = Prisma.ProductionTaskGetPayload<{
    include: typeof taskWithDetailsInclude;
}>;

type TaskItemWithDetails = TaskWithDetails['items'][0];
type ProductWithDetails = TaskItemWithDetails['product'];
type DoughWithRecursiveIngredients = ProductWithDetails['recipeVersion']['doughs'][0];

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

    private async _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): Promise<PrepTask | null> {
        if (!task || !task.items || task.items.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, { family: any; totalWeight: number }>();

        for (const item of task.items) {
            const product = item.product;
            if (!product) continue;
            const recipeVersion = product.recipeVersion;
            if (!recipeVersion) continue;

            // [核心修复] 调用新的、更准确的总面粉计算方法
            const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

            for (const dough of recipeVersion.doughs) {
                // [核心修改] 根据损耗率计算投料总重
                const lossRatio = dough.lossRatio || 0;
                const divisor = 1 - lossRatio;
                if (divisor <= 0) continue;
                const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

                const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                if (totalRatio > 0) {
                    const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);
                    for (const ing of dough.ingredients) {
                        if (ing.linkedPreDoughId && ing.linkedPreDough?.type === RecipeType.PRE_DOUGH) {
                            const weight = weightPerRatioPoint.mul(ing.ratio).toNumber() * item.quantity;
                            const existing = requiredPrepItems.get(ing.linkedPreDoughId);
                            if (existing) {
                                existing.totalWeight += weight;
                            } else {
                                requiredPrepItems.set(ing.linkedPreDoughId, {
                                    family: ing.linkedPreDough,
                                    totalWeight: weight,
                                });
                            }
                        }
                    }
                }
            }

            for (const pIng of product.ingredients) {
                if (pIng.linkedExtraId && pIng.linkedExtra?.type === RecipeType.EXTRA) {
                    let weight = 0;
                    if (pIng.weightInGrams) {
                        weight = pIng.weightInGrams * item.quantity;
                    } else if (pIng.ratio) {
                        weight = ((totalFlourWeight * pIng.ratio) / 100) * item.quantity;
                    }

                    const existing = requiredPrepItems.get(pIng.linkedExtraId);
                    if (existing) {
                        existing.totalWeight += weight;
                    } else {
                        requiredPrepItems.set(pIng.linkedExtraId, {
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
        } else {
            targetDate = new Date();
        }
        const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

        const activeTasks = await this.prisma.productionTask.findMany({
            where: {
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
            },
            // [核心修复] 复用 taskWithDetailsInclude 以确保查询出的数据结构完整，从而修复 TypeScript 类型错误
            include: taskWithDetailsInclude,
        });

        if (activeTasks.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, { family: any; totalWeight: number }>();

        for (const task of activeTasks) {
            for (const item of task.items) {
                const product = item.product;
                const recipeVersion = product.recipeVersion;
                // [核心修复] 调用新的、更准确的总面粉计算方法
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

                for (const dough of recipeVersion.doughs) {
                    // [核心修改] 根据损耗率计算投料总重
                    const lossRatio = dough.lossRatio || 0;
                    const divisor = 1 - lossRatio;
                    if (divisor <= 0) continue;
                    const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

                    const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                    if (totalRatio > 0) {
                        const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);
                        for (const ing of dough.ingredients) {
                            if (ing.linkedPreDoughId && ing.linkedPreDough?.type === RecipeType.PRE_DOUGH) {
                                const weight = weightPerRatioPoint.mul(ing.ratio).toNumber() * item.quantity;
                                const existing = requiredPrepItems.get(ing.linkedPreDoughId);
                                if (existing) {
                                    existing.totalWeight += weight;
                                } else {
                                    requiredPrepItems.set(ing.linkedPreDoughId, {
                                        family: ing.linkedPreDough,
                                        totalWeight: weight,
                                    });
                                }
                            }
                        }
                    }
                }

                for (const pIng of product.ingredients) {
                    if (pIng.linkedExtraId && pIng.linkedExtra?.type === RecipeType.EXTRA) {
                        let weight = 0;
                        if (pIng.weightInGrams) {
                            weight = pIng.weightInGrams * item.quantity;
                        } else if (pIng.ratio) {
                            weight = ((totalFlourWeight * pIng.ratio) / 100) * item.quantity;
                        }

                        const existing = requiredPrepItems.get(pIng.linkedExtraId);
                        if (existing) {
                            existing.totalWeight += weight;
                        } else {
                            requiredPrepItems.set(pIng.linkedExtraId, {
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
        // [核心修改] 并行执行两个查询：一个是获取当天任务，另一个是获取全局统计
        const [tasksForDate, stats] = await Promise.all([
            this.findTasksForDate(tenantId, date),
            this.getGlobalPendingStats(tenantId),
        ]);

        const prepTask = await this._getPrepTask(tenantId, date);

        // [核心修改] 将统计数据和任务列表合并到同一个响应中返回
        return {
            stats,
            tasks: tasksForDate,
            prepTask,
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
        } else {
            targetDate = new Date();
        }
        const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

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
     * @description [核心新增] 这是一个内部辅助函数，用于计算全局的待完成任务统计
     * @param tenantId 租户ID
     * @returns 返回包含待完成数量的对象
     */
    private async getGlobalPendingStats(tenantId: string) {
        const pendingTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                deletedAt: null,
            },
            include: {
                items: true,
            },
        });

        const totalPendingCount = pendingTasks.reduce((sum, task) => {
            return sum + task.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
        }, 0);

        return {
            pendingCount: totalPendingCount,
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
            orderBy: {
                startDate: 'desc', // [修改] 按开始日期排序
            },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        // [核心修复] 为 reduce 的累加器提供显式类型，修复 ESLint 错误
        const groupedTasks = tasks.reduce(
            (acc: Record<string, ProductionTask[]>, task) => {
                const date = new Date(task.startDate).toLocaleDateString('zh-CN', {
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
            {} as Record<string, any[]>,
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

        const doughGroups = this._calculateDoughGroups(task, query);
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

    /**
     * @description [核心重构] 新增的私有方法，用于计算所有面团分组的详细信息
     */
    private _calculateDoughGroups(task: TaskWithDetails, query: QueryTaskDetailDto): DoughGroup[] {
        const { mixerType, envTemp, flourTemp, waterTemp } = query;
        const canCalculateIce =
            mixerType !== undefined && envTemp !== undefined && flourTemp !== undefined && waterTemp !== undefined;

        const doughTotalWaterMap = new Map<string, number>();
        if (canCalculateIce) {
            task.items.forEach((item) => {
                const product = item.product;
                if (!product) return;
                product.recipeVersion.doughs.forEach((dough) => {
                    // [核心修改] 根据损耗率计算投料总重
                    const lossRatio = dough.lossRatio || 0;
                    const divisor = 1 - lossRatio;
                    if (divisor <= 0) return;
                    const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

                    const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                    if (totalRatio === 0) return;
                    const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);
                    dough.ingredients.forEach((ing) => {
                        if (ing.ingredient?.name === '水') {
                            const waterWeight = weightPerRatioPoint.mul(ing.ratio).mul(item.quantity).toNumber();
                            const currentTotal = doughTotalWaterMap.get(dough.id) || 0;
                            doughTotalWaterMap.set(dough.id, currentTotal + waterWeight);
                        }
                    });
                });
            });
        }

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
            const mainDoughInfo = firstItem.product.recipeVersion.doughs[0];
            const mainDoughIngredientsMap = new Map<string, TaskIngredientDetail>();
            let totalDoughWeight = 0;

            data.items.forEach((item) => {
                const { product, quantity } = item;
                const { recipeVersion } = product;
                recipeVersion.doughs.forEach((dough) => {
                    if (dough.id === mainDoughInfo.id) {
                        // [核心修改] 根据损耗率计算投料总重
                        const lossRatio = dough.lossRatio || 0;
                        const divisor = 1 - lossRatio;
                        if (divisor <= 0) return;
                        const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

                        const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                        if (totalRatio === 0) return;
                        const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);

                        dough.ingredients.forEach((ing) => {
                            const weight = weightPerRatioPoint.mul(ing.ratio).mul(quantity).toNumber();
                            totalDoughWeight += weight;
                            const ingId = ing.ingredient?.id || ing.linkedPreDough?.id;
                            if (!ingId) return;

                            let name = '未知原料';
                            if (ing.ingredient) {
                                name = ing.ingredient.name;
                            } else if (ing.linkedPreDough) {
                                name = ing.linkedPreDough.name;
                            }

                            if (canCalculateIce && name === '水' && dough.targetTemp) {
                                const totalWaterForDough = doughTotalWaterMap.get(dough.id);
                                if (totalWaterForDough && totalWaterForDough > 0) {
                                    const targetWaterTemp = this._calculateWaterTemp(
                                        dough.targetTemp,
                                        mixerType,
                                        flourTemp,
                                        envTemp,
                                    );
                                    const iceWeight = this._calculateIce(
                                        targetWaterTemp,
                                        totalWaterForDough,
                                        waterTemp,
                                    );
                                    if (iceWeight > 0) {
                                        // 在显示时可以格式化，但计算时保留精度
                                        const formattedIceWeight = iceWeight.toFixed(1);
                                        name = `水 (含 ${formattedIceWeight}g 冰)`;
                                    }
                                }
                            }

                            const existing = mainDoughIngredientsMap.get(ingId);
                            if (existing) {
                                existing.weightInGrams += weight;
                            } else {
                                mainDoughIngredientsMap.set(ingId, {
                                    id: ingId,
                                    name,
                                    brand: ing.ingredient?.activeSku?.brand || null,
                                    weightInGrams: weight,
                                });
                            }
                        });
                    }
                });
            });

            const products: DoughProductSummary[] = [];
            const productDetails: ProductDetails[] = [];
            data.items.forEach((item) => {
                const { product, quantity } = item;
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
                let totalMixInWeight = 0;

                const mixIns = product.ingredients
                    .filter((ing) => ing.type === 'MIX_IN' && ing.ingredient)
                    .map((ing) => {
                        const weight = ((totalFlourWeight * (ing.ratio || 0)) / 100) * quantity;
                        totalMixInWeight += weight;
                        return {
                            id: ing.ingredient!.id,
                            name: ing.ingredient!.name,
                            brand: ing.ingredient!.activeSku?.brand || null,
                            weightInGrams: weight,
                        };
                    });

                products.push({
                    id: product.id,
                    name: product.name,
                    quantity: quantity,
                    totalBaseDoughWeight: product.baseDoughWeight * quantity,
                    divisionWeight: product.baseDoughWeight + totalMixInWeight / quantity,
                });

                productDetails.push({
                    id: product.id,
                    name: product.name,
                    mixIns: mixIns,
                    fillings: product.ingredients
                        .filter((ing) => ing.type === 'FILLING' && (ing.ingredient || ing.linkedExtra))
                        .map((ing) => {
                            const id = ing.ingredient ? ing.ingredient.id : ing.linkedExtra!.id;
                            const name = ing.ingredient ? ing.ingredient.name : ing.linkedExtra!.name;
                            const brand = ing.ingredient ? ing.ingredient.activeSku?.brand || null : null;

                            return {
                                id,
                                name,
                                brand,
                                weightInGrams: ing.weightInGrams || 0,
                            };
                        }),
                    procedure: product.procedure || [],
                });
            });

            doughGroups.push({
                familyId,
                familyName: data.familyName,
                productsDescription: data.items.map((i) => `${i.product.name} x${i.quantity}`).join(', '),
                totalDoughWeight,
                mainDoughIngredients: Array.from(mainDoughIngredientsMap.values()),
                mainDoughProcedure: mainDoughInfo.procedure || [],
                products,
                productDetails,
            });
        }
        return doughGroups;
    }

    /**
     * @description [核心新增] 新增的私有方法，用于递归计算一个产品中所有来源（主面团、预制面团）的面粉总重量
     * @param product 包含完整配方信息的产品对象
     * @returns {number} 以克为单位的总面粉重量
     */
    private _calculateTotalFlourWeightForProduct(product: ProductWithDetails): number {
        const mainDough = product.recipeVersion.doughs[0];
        if (!mainDough) return 0;

        // [核心修改] 根据损耗率计算投料总重
        const lossRatio = mainDough.lossRatio || 0;
        const divisor = 1 - lossRatio;
        if (divisor <= 0) return 0;
        const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

        const totalRatio = mainDough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
        if (totalRatio === 0) return 0;

        const weightPerRatioPoint = adjustedDoughWeight.div(totalRatio);

        let totalFlourWeight = 0;
        const processedDoughs = new Set<string>();

        // 定义一个递归函数来计算面团中的面粉
        const calculateFlourInDough = (
            dough: DoughWithRecursiveIngredients,
            currentWeightPerRatioPoint: Prisma.Decimal,
        ) => {
            if (processedDoughs.has(dough.id)) return;
            processedDoughs.add(dough.id);

            dough.ingredients.forEach((ing) => {
                if (ing.ingredient?.isFlour) {
                    totalFlourWeight += currentWeightPerRatioPoint.mul(ing.ratio).toNumber();
                } else if (ing.linkedPreDough) {
                    const activeVersion = ing.linkedPreDough.versions.find((v) => v.isActive);
                    if (activeVersion && activeVersion.doughs[0]) {
                        const preDough = activeVersion.doughs[0] as DoughWithRecursiveIngredients;
                        // [核心修改] 根据预制面团自身的损耗率计算其投料总重
                        const preDoughLossRatio = preDough.lossRatio || 0;
                        const preDoughDivisor = 1 - preDoughLossRatio;
                        if (preDoughDivisor <= 0) return;

                        const preDoughTotalRatio = preDough.ingredients.reduce((sum, i) => sum + i.ratio, 0);
                        if (preDoughTotalRatio > 0) {
                            const preDoughWeight = currentWeightPerRatioPoint.mul(ing.ratio).toNumber();
                            const adjustedPreDoughWeight = new Prisma.Decimal(preDoughWeight).div(preDoughDivisor);
                            const preDoughWeightPerRatioPoint = adjustedPreDoughWeight.div(preDoughTotalRatio);
                            calculateFlourInDough(preDough, preDoughWeightPerRatioPoint);
                        }
                    }
                }
            });
        };

        calculateFlourInDough(mainDough, weightPerRatioPoint);

        return totalFlourWeight;
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

    // [核心修改] 函数签名增加 userId 参数
    async complete(tenantId: string, userId: string, id: string, completeProductionTaskDto: CompleteProductionTaskDto) {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: {
                // [核心修改] 关联查询产品名称，用于生成损耗原因
                items: {
                    include: {
                        product: {
                            select: { name: true },
                        },
                    },
                },
            },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        if (task.status !== ProductionTaskStatus.PENDING && task.status !== ProductionTaskStatus.IN_PROGRESS) {
            throw new BadRequestException('只有“待开始”或“进行中”的任务才能被完成');
        }

        const { notes, losses = [] } = completeProductionTaskDto;

        const successfulQuantities = new Map<string, number>();
        task.items.forEach((item) => {
            successfulQuantities.set(item.productId, item.quantity);
        });

        losses.forEach((loss) => {
            const currentQuantity = successfulQuantities.get(loss.productId) || 0;
            successfulQuantities.set(loss.productId, Math.max(0, currentQuantity - loss.quantity));
        });

        return this.prisma.$transaction(async (tx) => {
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    notes,
                },
            });

            for (const loss of losses) {
                await tx.productionTaskSpoilageLog.create({
                    data: {
                        productionLogId: productionLog.id,
                        productId: loss.productId,
                        stage: loss.stage,
                        quantity: loss.quantity,
                    },
                });

                const spoiledConsumptions = await this.costingService.calculateProductConsumptions(
                    tenantId,
                    loss.productId,
                    loss.quantity,
                );

                for (const consumption of spoiledConsumptions) {
                    const productName =
                        task.items.find((i) => i.productId === loss.productId)?.product.name || '未知产品';

                    // [核心修改] 使用映射表将英文阶段转换为中文
                    const translatedStage = stageToChineseMap[loss.stage] || loss.stage;

                    await tx.ingredientStockAdjustment.create({
                        data: {
                            ingredientId: consumption.ingredientId,
                            userId: userId, // [核心修复] 使用传入的 userId
                            changeInGrams: -consumption.totalConsumed,
                            // [核心修改] 使用中文原因
                            reason: `生产损耗: ${productName} - ${translatedStage}`,
                        },
                    });
                }
            }

            const successfulConsumptions = new Map<string, { totalConsumed: number; activeSkuId: string | null }>();

            for (const [productId, quantity] of successfulQuantities.entries()) {
                if (quantity > 0) {
                    const consumptions = await this.costingService.calculateProductConsumptions(
                        tenantId,
                        productId,
                        quantity,
                    );
                    for (const consumption of consumptions) {
                        const existing = successfulConsumptions.get(consumption.ingredientId);
                        if (existing) {
                            existing.totalConsumed += consumption.totalConsumed;
                        } else {
                            successfulConsumptions.set(consumption.ingredientId, {
                                totalConsumed: consumption.totalConsumed,
                                activeSkuId: consumption.activeSkuId,
                            });
                        }
                    }
                }
            }

            const ingredientIds = Array.from(successfulConsumptions.keys());
            const ingredients = await tx.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, currentStockInGrams: true, currentStockValue: true },
            });
            const ingredientDataMap = new Map(ingredients.map((i) => [i.id, i]));

            for (const [ingredientId, consumption] of successfulConsumptions.entries()) {
                await tx.ingredientConsumptionLog.create({
                    data: {
                        productionLogId: productionLog.id,
                        ingredientId: ingredientId,
                        skuId: consumption.activeSkuId,
                        quantityInGrams: consumption.totalConsumed,
                    },
                });

                const ingredient = ingredientDataMap.get(ingredientId);
                if (ingredient) {
                    const decrementAmount = Math.min(ingredient.currentStockInGrams, consumption.totalConsumed);
                    const currentStockValue = new Prisma.Decimal(ingredient.currentStockValue.toString());
                    let valueToDecrement = new Prisma.Decimal(0);
                    if (ingredient.currentStockInGrams > 0) {
                        const avgPricePerGram = currentStockValue.div(ingredient.currentStockInGrams);
                        valueToDecrement = avgPricePerGram.mul(decrementAmount);
                    }

                    await tx.ingredient.update({
                        where: { id: ingredientId },
                        data: {
                            currentStockInGrams: {
                                decrement: decrementAmount,
                            },
                            currentStockValue: {
                                decrement: valueToDecrement,
                            },
                        },
                    });
                }
            }
            return this.findOne(tenantId, id, {});
        });
    }
}
