import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import { IngredientType, Prisma, ProductionTaskStatus } from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService } from '../costing/costing.service';

@Injectable()
export class ProductionTasksService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly costingService: CostingService,
    ) {}

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
                select: { id: true, name: true, currentStockInGrams: true, type: true }, // [修复] 查询原料类型
            });

            // [新增] 只对“标准原料”进行库存检查
            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);

            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];

            for (const consumption of finalConsumptions) {
                const ingredient = ingredientStockMap.get(consumption.ingredientId);
                // [修改] 仅当原料在待检查列表中时才进行比较
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
        const { status, plannedDate, page = '1', limit = '10' } = query;
        const pageNum = parseInt(page, 10);
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

        const isHistoryQuery = status && status.some((s) => ['COMPLETED', 'CANCELLED'].includes(s));

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
                plannedDate: 'asc',
            },
        });
    }

    async findOne(tenantId: string, id: string) {
        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            include: {
                items: {
                    include: {
                        // [修复] 修复任务详情页面无法打开的问题
                        // [修改] 之前只查询了 product: true，现在需要深入查询，以确保前端能获取到 recipeVersion 和 family
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

        // [核心修改] 开始计算任务所需的原料总量，用于称重
        const totalIngredientsMap = new Map<string, { name: string; totalWeight: number }>();

        // 并发计算所有任务项的原料消耗
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

        // 将Map转换为数组并排序，方便客户端展示
        const totalIngredients = Array.from(totalIngredientsMap.entries())
            .map(([ingredientId, data]) => ({
                ingredientId,
                name: data.name,
                totalWeightInGrams: data.totalWeight,
            }))
            .sort((a, b) => b.totalWeightInGrams - a.totalWeightInGrams); // 按重量降序排列

        // 如果任务已完成或取消，则不显示库存警告
        if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
            return { ...task, totalIngredients, stockWarning: null };
        }

        // 实时计算库存警告
        let stockWarning: string | null = null;
        const ingredientIds = totalIngredients.map((c) => c.ingredientId);
        if (ingredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, type: true }, // [修复] 查询原料类型
            });

            // [新增] 只对“标准原料”进行库存检查
            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);

            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];

            for (const consumption of totalIngredients) {
                const ingredient = ingredientStockMap.get(consumption.ingredientId);
                // [修改] 仅当原料在待检查列表中时才进行比较
                if (ingredient && ingredient.currentStockInGrams < consumption.totalWeightInGrams) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }

        return { ...task, totalIngredients, stockWarning };
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
