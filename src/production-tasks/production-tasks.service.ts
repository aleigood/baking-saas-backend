import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import { IngredientType, Prisma, ProductionTask, ProductionTaskStatus, RecipeType } from '@prisma/client'; // [修改] 导入ProductionTask
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService, CalculatedRecipeDetails } from '../costing/costing.service';
// [新增] 导入新增的 DTO
import { QueryTaskDetailDto } from './dto/query-task-detail.dto';

// ... (PrepTask interface remains the same)
export interface PrepTask {
    id: string;
    title: string;
    details: string;
    items: CalculatedRecipeDetails[];
}

// [核心改造] 更新类型定义，以包含更深层次的关联数据
type TaskWithDetails = Prisma.ProductionTaskGetPayload<{
    include: {
        items: {
            include: {
                product: {
                    include: {
                        recipeVersion: {
                            include: {
                                family: true;
                                doughs: {
                                    include: {
                                        ingredients: {
                                            include: {
                                                ingredient: { include: { activeSku: true } }; // 包含 activeSku
                                                linkedPreDough: true;
                                            };
                                        };
                                    };
                                };
                            };
                        };
                        ingredients: {
                            // 产品自身的辅料、馅料
                            include: {
                                ingredient: { include: { activeSku: true } }; // 包含 activeSku
                                linkedExtra: true;
                            };
                        };
                    };
                };
            };
        };
    };
}>;

@Injectable()
export class ProductionTasksService {
    // ... (constructor, _getPrepItemsForTask, _getPrepTask, create, findActive, findHistory remain the same)
    constructor(
        private readonly prisma: PrismaService,
        private readonly costingService: CostingService,
    ) {}

    /**
     * @description [新增] 计算所需的水温
     * @param targetTemp 面团目标温度
     * @param mixerType 搅拌机温升系数
     * @param flourTemp 面粉温度
     * @param ambientTemp 环境温度
     * @returns {number} 目标水温
     */
    private _calculateWaterTemp(targetTemp: number, mixerType: number, flourTemp: number, ambientTemp: number): number {
        // T_w = (T_d - F) * 3 - T_f - T_a
        return (targetTemp - mixerType) * 3 - flourTemp - ambientTemp;
    }

    /**
     * @description [新增] 计算需要替换为冰块的水量
     * @param targetWaterTemp 目标水温
     * @param totalWater 总用水量
     * @param initialWaterTemp 初始水温
     * @returns {number} 需要的冰块克数 (四舍五入)
     */
    private _calculateIce(targetWaterTemp: number, totalWater: number, initialWaterTemp: number): number {
        if (targetWaterTemp >= initialWaterTemp) {
            return 0;
        }
        // Ice = (TotalWater * (InitialWaterTemp - TargetWaterTemp)) / (InitialWaterTemp + 80)
        const ice = (totalWater * (initialWaterTemp - targetWaterTemp)) / (initialWaterTemp + 80);
        return Math.round(ice);
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

            let totalFlourWeight = 0;

            for (const dough of recipeVersion.doughs) {
                const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                if (totalRatio > 0) {
                    const weightPerRatioPoint = new Prisma.Decimal(product.baseDoughWeight).div(totalRatio);
                    for (const ing of dough.ingredients) {
                        if (ing.ingredient?.isFlour) {
                            totalFlourWeight += weightPerRatioPoint.mul(ing.ratio).toNumber();
                        }
                    }
                }
            }

            for (const dough of recipeVersion.doughs) {
                const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                if (totalRatio > 0) {
                    const weightPerRatioPoint = new Prisma.Decimal(product.baseDoughWeight).div(totalRatio);
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
            include: {
                items: {
                    include: {
                        product: {
                            include: {
                                recipeVersion: {
                                    include: {
                                        doughs: {
                                            include: {
                                                ingredients: {
                                                    include: {
                                                        linkedPreDough: true,
                                                        ingredient: true,
                                                    },
                                                },
                                            },
                                        },
                                        family: true,
                                    },
                                },
                                ingredients: {
                                    include: {
                                        linkedExtra: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (activeTasks.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, { family: any; totalWeight: number }>();

        for (const task of activeTasks) {
            for (const item of task.items) {
                const product = item.product;
                const recipeVersion = product.recipeVersion;
                let totalFlourWeight = 0;

                for (const dough of recipeVersion.doughs) {
                    const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                    if (totalRatio > 0) {
                        const weightPerRatioPoint = new Prisma.Decimal(product.baseDoughWeight).div(totalRatio);
                        for (const ing of dough.ingredients) {
                            if (ing.ingredient?.isFlour) {
                                totalFlourWeight += weightPerRatioPoint.mul(ing.ratio).toNumber();
                            }
                        }
                    }
                }

                for (const dough of recipeVersion.doughs) {
                    const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                    if (totalRatio > 0) {
                        const weightPerRatioPoint = new Prisma.Decimal(product.baseDoughWeight).div(totalRatio);
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
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
        } else {
            targetDate = new Date();
        }
        // [新增] 计算所选日期的开始和结束时间
        const startOfDay = new Date(targetDate.setHours(0, 0, 0, 0));
        const endOfDay = new Date(targetDate.setHours(23, 59, 59, 999));

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
            status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
            // [修改] 新的日期筛选逻辑
            startDate: {
                lte: endOfDay, // 任务的开始时间必须在所选日期的结束之前
            },
            OR: [
                {
                    endDate: {
                        gte: startOfDay, // 任务的结束时间必须在所选日期的开始之后
                    },
                },
                {
                    endDate: null, // 或者任务没有结束时间
                },
            ],
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
                startDate: 'asc', // [修改] 按开始日期排序
            },
        });

        const prepTask = await this._getPrepTask(tenantId, date);

        return {
            tasks,
            prepTask,
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

    async findOne(tenantId: string, id: string, query: QueryTaskDetailDto) {
        console.log('Received query params for ice calculation:', query);

        if (id === 'prep-task-01') {
            return this._getPrepTask(tenantId);
        }

        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            include: {
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
                                                        linkedPreDough: true,
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
                    include: {
                        consumptionLogs: {
                            include: {
                                ingredient: true,
                                sku: true,
                            },
                        },
                    },
                },
            },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        // [核心新增] 冰块计算逻辑
        const { mixerType, envTemp, flourTemp, waterTemp } = query;
        const canCalculateIce =
            mixerType !== undefined && envTemp !== undefined && flourTemp !== undefined && waterTemp !== undefined;

        if (canCalculateIce) {
            // 1. 计算每个面团配方的总水量
            const doughTotalWaterMap = new Map<string, number>();

            task.items.forEach((item) => {
                const product = item.product;
                if (!product) return;

                product.recipeVersion.doughs.forEach((dough) => {
                    const totalRatio = dough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);
                    if (totalRatio === 0) return;

                    const weightPerRatioPoint = new Prisma.Decimal(product.baseDoughWeight).div(totalRatio);

                    dough.ingredients.forEach((ing) => {
                        // 假设水的原料名称为'水'
                        if (ing.ingredient?.name === '水') {
                            const waterWeight = weightPerRatioPoint.mul(ing.ratio).mul(item.quantity).toNumber();
                            const currentTotal = doughTotalWaterMap.get(dough.id) || 0;
                            doughTotalWaterMap.set(dough.id, currentTotal + waterWeight);
                        }
                    });
                });
            });

            // 2. 遍历任务，修改水的名称以包含冰块信息
            task.items.forEach((item) => {
                item.product?.recipeVersion.doughs.forEach((dough) => {
                    const doughTargetTemp = dough.targetTemp;
                    const totalWaterForDough = doughTotalWaterMap.get(dough.id);

                    if (doughTargetTemp && totalWaterForDough && totalWaterForDough > 0) {
                        const waterIngredient = dough.ingredients.find((ing) => ing.ingredient?.name === '水');

                        if (waterIngredient && waterIngredient.ingredient) {
                            const targetWaterTemp = this._calculateWaterTemp(
                                doughTargetTemp,
                                mixerType,
                                flourTemp,
                                envTemp,
                            );
                            const iceWeight = this._calculateIce(targetWaterTemp, totalWaterForDough, waterTemp);

                            if (iceWeight > 0) {
                                // [核心修复] 移除(as any)类型断言，直接对类型安全的属性进行赋值，以解决ESLint错误
                                waterIngredient.ingredient.name = `水 (含 ${iceWeight}g 冰)`;
                            }
                        }
                    }
                });
            });
        }

        const prepTask = await this._getPrepItemsForTask(tenantId, task);

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

        const totalIngredients = Array.from(totalIngredientsMap.entries())
            .map(([ingredientId, data]) => ({
                ingredientId,
                name: data.name,
                totalWeightInGrams: data.totalWeight,
            }))
            .sort((a, b) => b.totalWeightInGrams - a.totalWeightInGrams);

        if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
            return { ...task, totalIngredients, stockWarning: null, prepTask };
        }

        let stockWarning: string | null = null;
        const ingredientIds = totalIngredients.map((c) => c.ingredientId);
        if (ingredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, type: true },
            });

            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);

            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];

            for (const consumption of totalIngredients) {
                const ingredient = ingredientStockMap.get(consumption.ingredientId);
                if (ingredient && ingredient.currentStockInGrams < consumption.totalWeightInGrams) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }

        return { ...task, totalIngredients, stockWarning, prepTask };
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

    async complete(tenantId: string, id: string, completeProductionTaskDto: CompleteProductionTaskDto) {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: { items: true },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        if (task.status !== ProductionTaskStatus.PENDING && task.status !== ProductionTaskStatus.IN_PROGRESS) {
            throw new BadRequestException('只有“待开始”或“进行中”的任务才能被完成');
        }

        const { notes } = completeProductionTaskDto;

        const allConsumptions = new Map<
            string,
            {
                ingredientId: string;
                ingredientName: string;
                activeSkuId: string | null;
                totalConsumed: number;
            }
        >();

        for (const item of task.items) {
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
                    allConsumptions.set(consumption.ingredientId, { ...consumption });
                }
            }
        }

        const finalConsumptions = Array.from(allConsumptions.values());

        return this.prisma.$transaction(async (tx) => {
            const ingredientIds = finalConsumptions.map((c) => c.ingredientId);
            const ingredients = await tx.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, currentStockValue: true },
            });
            const ingredientDataMap = new Map(ingredients.map((i) => [i.id, i]));

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

            for (const consumption of finalConsumptions) {
                await tx.ingredientConsumptionLog.create({
                    data: {
                        productionLogId: productionLog.id,
                        ingredientId: consumption.ingredientId,
                        skuId: consumption.activeSkuId,
                        quantityInGrams: consumption.totalConsumed,
                    },
                });

                const ingredient = ingredientDataMap.get(consumption.ingredientId);
                if (ingredient) {
                    const decrementAmount = Math.min(ingredient.currentStockInGrams, consumption.totalConsumed);

                    const currentStockValue = new Prisma.Decimal(ingredient.currentStockValue.toString());
                    let valueToDecrement = new Prisma.Decimal(0);
                    if (ingredient.currentStockInGrams > 0) {
                        const avgPricePerGram = currentStockValue.div(ingredient.currentStockInGrams);
                        valueToDecrement = avgPricePerGram.mul(decrementAmount);
                    }

                    await tx.ingredient.update({
                        where: { id: consumption.ingredientId },
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
