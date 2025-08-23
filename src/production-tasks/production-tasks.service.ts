import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import { IngredientType, Prisma, ProductionTaskStatus, RecipeType } from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService, CalculatedRecipeDetails } from '../costing/costing.service';

// [修复] 导出 PrepTask 接口以解决 TS4053 错误
// (Fix: Export the PrepTask interface to resolve the TS4053 error)
export interface PrepTask {
    id: string;
    title: string;
    details: string;
    items: CalculatedRecipeDetails[];
}

// [核心修正] 为任务详情的复杂 Prisma 查询结果定义精确的类型
// (Core Fix: Define a precise type for the complex Prisma query result of task details)
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
                                                ingredient: true;
                                                linkedPreDough: true;
                                            };
                                        };
                                    };
                                };
                            };
                        };
                        ingredients: {
                            include: {
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
    constructor(
        private readonly prisma: PrismaService,
        private readonly costingService: CostingService,
    ) {}

    // [核心修正] 重构私有方法，使用精确类型并增加健壮性检查
    private async _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): Promise<PrepTask | null> {
        // [修正] 增加对 task 和 task.items 的有效性检查
        if (!task || !task.items || task.items.length === 0) {
            return null;
        }

        const requiredPrepItems = new Map<string, { family: any; totalWeight: number }>();

        for (const item of task.items) {
            // [修正] 增加对 product 和 recipeVersion 的存在性检查
            const product = item.product;
            if (!product) continue;
            const recipeVersion = product.recipeVersion;
            if (!recipeVersion) continue;

            let totalFlourWeight = 0;

            // 计算总粉量
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

            // 遍历面团中的预制面团
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

            // 遍历产品中的附加项（馅料等）
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

    private async _getPrepTask(tenantId: string): Promise<PrepTask | null> {
        const activeTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
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
                                                        ingredient: true, // [修复] 增加 ingredient 的查询以解决 TS2551 错误
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

                // 计算总粉量
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

                // 遍历面团中的预制面团
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

                // 遍历产品中的附加项（馅料等）
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
        const { plannedDate, notes, products } = createProductionTaskDto;

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
                plannedDate,
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

    async findAll(tenantId: string, query: QueryProductionTaskDto) {
        const { status, plannedDate, page, limit = '10' } = query;
        const pageNum = parseInt(page || '1', 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
        };

        if (status && status.length > 0) {
            where.status = { in: status };
        }

        if (plannedDate) {
            const startOfDay = new Date(plannedDate);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(plannedDate);
            endOfDay.setHours(23, 59, 59, 999);
            where.plannedDate = {
                gte: startOfDay,
                lte: endOfDay,
            };
        }

        // [核心修复] 使用 `page` 参数的存在来更准确地判断是否为历史记录的分页查询
        const isHistoryQuery = !!page;

        if (isHistoryQuery) {
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
                    plannedDate: 'desc',
                },
                skip: (pageNum - 1) * limitNum,
                take: limitNum,
            });

            const groupedTasks = tasks.reduce(
                (acc, task) => {
                    const date = new Date(task.plannedDate).toLocaleDateString('zh-CN', {
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
                plannedDate: 'asc',
            },
        });

        const prepTask = await this._getPrepTask(tenantId);

        return {
            tasks,
            prepTask,
        };
    }

    async findOne(tenantId: string, id: string) {
        if (id === 'prep-task-01') {
            return this._getPrepTask(tenantId);
        }

        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            // [核心修正] 使用 Prisma.ProductionTaskGetPayload<T> 来帮助 TS 推断正确的类型
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
                                                        ingredient: true,
                                                        linkedPreDough: true,
                                                    },
                                                },
                                            },
                                        },
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

        // [核心修正] 调用新的私有方法计算备料清单，并传入类型正确的 task 对象
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
        await this.findOne(tenantId, id);
        return this.prisma.productionTask.update({
            where: { id },
            data: updateProductionTaskDto,
        });
    }

    async remove(tenantId: string, id: string) {
        await this.findOne(tenantId, id);
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

            return this.findOne(tenantId, id);
        });
    }
}
