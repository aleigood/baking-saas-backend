import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
// [FIX] 导入 Prisma 类型以增强类型安全
// (Import Prisma types for enhanced type safety)
import { Prisma, ProductionTaskStatus } from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService } from '../costing/costing.service';

@Injectable()
export class ProductionTasksService {
    constructor(
        private readonly prisma: PrismaService,
        // 注入成本计算服务，用于获取配方成分
        // (Inject costing service to get recipe ingredients)
        private readonly costingService: CostingService,
    ) {}

    /**
     * [核心修改] 创建任务时增加库存预警
     * @param tenantId 租户ID
     * @param createProductionTaskDto DTO
     */
    async create(tenantId: string, createProductionTaskDto: CreateProductionTaskDto) {
        const { plannedDate, notes, products } = createProductionTaskDto;

        if (!products || products.length === 0) {
            throw new BadRequestException('一个生产任务至少需要包含一个产品。');
        }

        // 1. 验证所有目标产品是否存在且属于该租户
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

        // 2. 计算任务所需的原料总消耗
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

        // 3. 检查库存并生成警告信息
        let stockWarning: string | null = null;
        if (finalConsumptions.length > 0) {
            const ingredientIds = finalConsumptions.map((c) => c.ingredientId);
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true },
            });
            const ingredientStockMap = new Map(ingredients.map((i) => [i.id, i]));
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

        // 4. 创建任务和任务项
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

        // 5. 返回创建的任务和警告信息
        return { task: createdTask, warning: stockWarning };
    }

    // [REFACTORED] 重构 findAll 方法以支持分页和分组
    async findAll(tenantId: string, query: QueryProductionTaskDto) {
        const { status, plannedDate, page = '1', limit = '10' } = query;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
        };

        if (status && status.length > 0) {
            // [MODIFIED] 支持状态数组查询
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

        // [ADDED] 检查是否是历史任务查询，如果是则应用分页和分组逻辑
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
                    plannedDate: 'desc', // 按日期降序排序
                },
                skip: (pageNum - 1) * limitNum,
                take: limitNum,
            });

            // [ADDED] 按日期进行分组
            const groupedTasks = tasks.reduce(
                (acc, task) => {
                    // 格式化日期为 'MM月DD日 星期X'
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

        // 对于进行中的任务，保持原有逻辑，不分页
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

    /**
     * [核心修改] 查询任务详情时，实时计算库存警告
     * @param tenantId
     * @param id
     * @returns
     */
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
                        product: true,
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

        // 如果任务已完成或取消，则不显示库存警告
        if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
            return task;
        }

        // 实时计算库存警告
        const allConsumptions = new Map<
            string,
            { ingredientId: string; ingredientName: string; totalConsumed: number }
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
                select: { id: true, name: true, currentStockInGrams: true },
            });
            const ingredientStockMap = new Map(ingredients.map((i) => [i.id, i]));
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

        return { ...task, stockWarning };
    }

    // 更新生产任务
    // (Update a production task)
    async update(tenantId: string, id: string, updateProductionTaskDto: UpdateProductionTaskDto) {
        await this.findOne(tenantId, id);
        return this.prisma.productionTask.update({
            where: { id },
            data: updateProductionTaskDto,
        });
    }

    // 软删除生产任务
    // (Soft delete a production task)
    async remove(tenantId: string, id: string) {
        await this.findOne(tenantId, id);
        return this.prisma.productionTask.update({
            where: { id },
            data: {
                deletedAt: new Date(),
            },
        });
    }

    /**
     * [核心修改] 完成任务时，如果库存不足则清零，不阻止任务完成
     * @param tenantId 租户ID
     * @param id 任务ID
     * @param completeProductionTaskDto DTO
     */
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
                select: { id: true, name: true, currentStockInGrams: true },
            });
            const ingredientStockMap = new Map(ingredients.map((i) => [i.id, i]));

            // 更新任务状态
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            // 创建生产日志
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    notes,
                },
            });

            // 遍历消耗列表，创建消耗日志并扣减库存
            for (const consumption of finalConsumptions) {
                if (!consumption.activeSkuId) {
                    continue;
                }

                await tx.ingredientConsumptionLog.create({
                    data: {
                        productionLogId: productionLog.id,
                        ingredientId: consumption.ingredientId,
                        skuId: consumption.activeSkuId,
                        quantityInGrams: consumption.totalConsumed,
                    },
                });

                const ingredient = ingredientStockMap.get(consumption.ingredientId);
                if (ingredient) {
                    // [核心修改] 计算实际可扣减的库存量，确保不为负
                    const decrementAmount = Math.min(ingredient.currentStockInGrams, consumption.totalConsumed);

                    await tx.ingredient.update({
                        where: { id: consumption.ingredientId },
                        data: {
                            currentStockInGrams: {
                                decrement: decrementAmount,
                            },
                        },
                    });
                }
            }

            return this.findOne(tenantId, id);
        });
    }
}
