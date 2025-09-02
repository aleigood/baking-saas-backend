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

// [核心修复] 为 prepare task 中的对象定义明确的类型，以消除 'any' 警告
type PrepItemFamily = RecipeFamily;
type RequiredPrepItem = { family: PrepItemFamily; totalWeight: number };

// [核心修复] 为扁平化后的原料对象定义明确的类型
type FlattenedIngredient = {
    id: string;
    name: string;
    weight: number;
    brand: string | null;
    isRecipe: boolean;
    recipeType?: RecipeType;
    recipeFamily?: PrepItemFamily;
    type?: ProductIngredientType;
    ratio?: number;
    weightInGrams?: number;
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

    private async _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): Promise<PrepTask | null> {
        if (!task || !task.items || task.items.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, RequiredPrepItem>();

        for (const item of task.items) {
            const product = item.product;
            if (!product) continue;

            const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

            const allIngredients = this._flattenIngredientsForProduct(product);
            for (const [ingredientId, data] of allIngredients.entries()) {
                if (data.isRecipe && data.recipeType === 'PRE_DOUGH' && data.recipeFamily) {
                    const weight = data.weight * item.quantity;
                    const existing = requiredPrepItems.get(ingredientId);
                    if (existing) {
                        existing.totalWeight += weight;
                    } else {
                        requiredPrepItems.set(ingredientId, {
                            family: data.recipeFamily,
                            totalWeight: weight,
                        });
                    }
                } else if (data.isRecipe && data.recipeType === 'EXTRA' && data.recipeFamily) {
                    let weight = 0;
                    if (data.weightInGrams) {
                        weight = data.weightInGrams * item.quantity;
                    } else if (data.ratio) {
                        weight = totalFlourWeight * data.ratio * item.quantity;
                    }
                    const existing = requiredPrepItems.get(ingredientId);
                    if (existing) {
                        existing.totalWeight += weight;
                    } else {
                        requiredPrepItems.set(ingredientId, {
                            family: data.recipeFamily,
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
            // [核心修复] 增加日期有效性验证，防止因无效日期字符串导致查询失败
            if (isNaN(targetDate.getTime())) {
                throw new BadRequestException('提供的日期格式无效。');
            }
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

        const requiredPrepItems = new Map<string, RequiredPrepItem>();

        for (const task of activeTasks) {
            for (const item of task.items) {
                const product = item.product;
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

                const allIngredients = this._flattenIngredientsForProduct(product);
                for (const [ingredientId, data] of allIngredients.entries()) {
                    if (data.isRecipe && data.recipeType === 'PRE_DOUGH' && data.recipeFamily) {
                        const weight = data.weight * item.quantity;
                        const existing = requiredPrepItems.get(ingredientId);
                        if (existing) {
                            existing.totalWeight += weight;
                        } else {
                            requiredPrepItems.set(ingredientId, {
                                family: data.recipeFamily,
                                totalWeight: weight,
                            });
                        }
                    } else if (data.isRecipe && data.recipeType === 'EXTRA' && data.recipeFamily) {
                        let weight = 0;
                        if (data.weightInGrams) {
                            weight = data.weightInGrams * item.quantity;
                        } else if (data.ratio) {
                            weight = totalFlourWeight * data.ratio * item.quantity;
                        }
                        const existing = requiredPrepItems.get(ingredientId);
                        if (existing) {
                            existing.totalWeight += weight;
                        } else {
                            requiredPrepItems.set(ingredientId, {
                                family: data.recipeFamily,
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
        const [tasksForDate, todayStats] = await Promise.all([
            this.findTasksForDate(tenantId, date),
            this.getTodaysPendingStats(tenantId),
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
            stats: todayStats,
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
            // [核心修复] 增加日期有效性验证，防止因无效日期字符串导致查询失败
            if (isNaN(targetDate.getTime())) {
                throw new BadRequestException('提供的日期格式无效。');
            }
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
     * @description [核心修改] 此函数现在只计算今天的待完成任务总数
     * @param tenantId 租户ID
     * @returns 返回包含今日待完成数量的对象
     */
    private async getTodaysPendingStats(tenantId: string) {
        // [核心新增] 获取今天的开始和结束时间，确保查询不受时区影响
        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

        const pendingTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                deletedAt: null,
                // [核心新增] 增加日期过滤条件，只查询今天的任务
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

        const todayPendingCount = pendingTasks.reduce((sum, task) => {
            return sum + task.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
        }, 0);

        return {
            todayPendingCount: todayPendingCount,
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
            // [核心修改] 确保任务按开始日期的降序获取
            orderBy: {
                startDate: 'desc',
            },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        // [核心重构] 在服务端完成分组逻辑
        const groupedTasks = tasks.reduce(
            (acc: Record<string, ProductionTask[]>, task) => {
                // 使用任务的 startDate 进行分组，并格式化为 "月日 星期"
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

            let totalWaterForFamily = 0;
            const allIngredientsFirstProduct = this._flattenIngredientsForProduct(firstItem.product);
            for (const [, ingData] of allIngredientsFirstProduct.entries()) {
                if (ingData.name === '水') {
                    totalWaterForFamily += ingData.weight;
                }
            }
            totalWaterForFamily *= data.items.reduce((sum, item) => sum + item.quantity, 0);

            data.items.forEach((item) => {
                const { product, quantity } = item;
                const flattenedIngredients = this._flattenIngredientsForProduct(product);
                for (const [ingId, ingData] of flattenedIngredients.entries()) {
                    const weight = ingData.weight * quantity;
                    totalDoughWeight += weight;

                    let name = ingData.name;
                    if (canCalculateIce && name === '水' && mainDoughInfo.targetTemp) {
                        const targetWaterTemp = this._calculateWaterTemp(
                            mainDoughInfo.targetTemp,
                            mixerType,
                            flourTemp,
                            envTemp,
                        );
                        const iceWeight = this._calculateIce(targetWaterTemp, totalWaterForFamily, waterTemp);

                        if (iceWeight > 0) {
                            const icePerProduct = iceWeight / data.items.reduce((sum, i) => sum + i.quantity, 0);
                            const iceForThisItem = icePerProduct * quantity;
                            if (iceForThisItem > 0) {
                                name = `水 (含 ${iceForThisItem.toFixed(1)}g 冰)`;
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
                            brand: ingData.brand,
                            weightInGrams: weight,
                            isRecipe: ingData.isRecipe,
                        });
                    }
                }
            });

            const products: DoughProductSummary[] = [];
            const productDetails: ProductDetails[] = [];
            data.items.forEach((item) => {
                const { product, quantity } = item;
                const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
                const flattenedProductIngredients = this._flattenIngredientsForProduct(product, false);

                // [核心修复] 修正类型，确保返回对象符合 TaskIngredientDetail 接口
                const mixIns: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: (ing.ratio ?? 0) * totalFlourWeight,
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

                const mixInWeightPerUnit = mixIns.reduce((sum, i) => sum + i.weightInGrams, 0);

                const lossRatio = mainDoughInfo?.lossRatio || 0;
                const divisor = 1 - lossRatio;
                const adjustedBaseDoughWeight =
                    divisor > 0 ? product.baseDoughWeight / divisor : product.baseDoughWeight;
                const correctedDivisionWeight = adjustedBaseDoughWeight + mixInWeightPerUnit;

                products.push({
                    id: product.id,
                    name: product.name,
                    quantity: quantity,
                    totalBaseDoughWeight: product.baseDoughWeight * quantity,
                    divisionWeight: correctedDivisionWeight,
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
     * @description [核心重构] 新增一个私有辅助函数，用于将一个产品的所有原料（包括嵌套的预制面团）扁平化为一个列表
     * @param product 包含完整配方信息的产品对象
     * @param includeDough 是否包含面团中的原料，默认为true
     * @returns 返回一个Map，键为原料ID，值为原料的详细信息和重量
     */
    private _flattenIngredientsForProduct(
        product: ProductWithDetails,
        includeDough = true,
    ): Map<string, FlattenedIngredient> {
        const flattened = new Map<string, FlattenedIngredient>();
        const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

        if (includeDough) {
            const processDough = (dough: DoughWithRecursiveIngredients, flourWeightRef: number) => {
                const totalRatio = dough.ingredients.reduce((sum, i) => sum + (i.ratio ?? 0), 0);
                if (totalRatio === 0) return;

                for (const ing of dough.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
                        if (preDoughRecipe) {
                            const flourForPreDough = flourWeightRef * ing.flourRatio;
                            processDough(preDoughRecipe as DoughWithRecursiveIngredients, flourForPreDough);
                        }
                    } else if (ing.ingredient && ing.ratio) {
                        const weight = flourWeightRef * ing.ratio;
                        flattened.set(ing.ingredient.id, {
                            id: ing.ingredient.id,
                            name: ing.ingredient.name,
                            weight: weight,
                            brand: ing.ingredient.activeSku?.brand || null,
                            isRecipe: false,
                        });
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
                    weight: 0,
                    brand: pIng.ingredient.activeSku?.brand || null,
                    isRecipe: false,
                    type: pIng.type,
                    ratio: pIng.ratio ?? undefined,
                    weightInGrams: pIng.weightInGrams ?? undefined,
                });
            } else if (pIng.linkedExtra) {
                flattened.set(pIng.linkedExtra.id, {
                    id: pIng.linkedExtra.id,
                    name: pIng.linkedExtra.name,
                    weight: 0,
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

    /**
     * @description [核心重构] 此方法现在完全基于flourRatio实时计算总面粉量
     * @param product 包含完整配方信息的产品对象
     * @returns {number} 以克为单位的总面粉重量
     */
    private _calculateTotalFlourWeightForProduct(product: ProductWithDetails): number {
        const mainDough = product.recipeVersion.doughs[0];
        if (!mainDough) return 0;

        const lossRatio = mainDough.lossRatio || 0;
        const divisor = 1 - lossRatio;
        if (divisor <= 0) return 0;
        const adjustedDoughWeight = new Prisma.Decimal(product.baseDoughWeight).div(divisor);

        const calculateTotalRatio = (dough: DoughWithRecursiveIngredients): number => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions.find((v) => v.isActive)?.doughs[0];
                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce((s, pi) => s + (pi.ratio ?? 0), 0);
                        return sum + i.flourRatio * preDoughTotalRatio;
                    }
                }
                return sum + (i.ratio ?? 0);
            }, 0);
        };

        const totalRatio = calculateTotalRatio(mainDough);
        if (totalRatio === 0) return 0;

        return adjustedDoughWeight.div(totalRatio).toNumber();
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
