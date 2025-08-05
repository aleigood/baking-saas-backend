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
     * [V2.2 逻辑修改] 创建包含多个产品的生产任务
     * (Logic modified to create a production task with multiple products)
     * @param tenantId 租户ID (Tenant ID)
     * @param createProductionTaskDto DTO
     */
    async create(tenantId: string, createProductionTaskDto: CreateProductionTaskDto) {
        const { plannedDate, notes, products } = createProductionTaskDto;

        if (!products || products.length === 0) {
            throw new BadRequestException('一个生产任务至少需要包含一个产品。');
        }

        // 验证所有目标产品是否存在且属于该租户
        // (Validate that all target products exist and belong to the tenant)
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

        // 使用事务创建任务和任务项
        // (Use a transaction to create the task and task items)
        return this.prisma.productionTask.create({
            data: {
                plannedDate,
                notes,
                tenantId,
                items: {
                    create: products.map((p) => ({
                        productId: p.productId,
                        quantity: p.quantity,
                        // [移除] unit 字段已被删除
                        // (Removed: unit field has been deleted)
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
    }

    // 查询生产任务列表
    // (Find all production tasks)
    async findAll(tenantId: string, query: QueryProductionTaskDto) {
        const { status, plannedDate } = query;
        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
        };

        if (status) {
            where.status = status;
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

        return this.prisma.productionTask.findMany({
            where,
            include: {
                // [修改] 包含任务中的产品项
                // (Modified: Include product items in the task)
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

    // 查询单个生产任务详情
    // (Find a single production task)
    async findOne(tenantId: string, id: string) {
        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            include: {
                // [修改] 包含任务中的产品项
                // (Modified: Include product items in the task)
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
        return task;
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
     * [V2.2 核心逻辑重写] 完成生产任务，记录日志并扣减所有产品的库存
     * (Core logic rewrite: Complete a production task, log it, and deduct stock for all products)
     * @param tenantId 租户ID (Tenant ID)
     * @param id 任务ID (Task ID)
     * @param completeProductionTaskDto DTO
     */
    async complete(tenantId: string, id: string, completeProductionTaskDto: CompleteProductionTaskDto) {
        // [修改] 获取任务详情时，也获取其包含的所有产品项
        // (Modified: Also get all product items when fetching task details)
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: { items: true },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        if (task.status !== ProductionTaskStatus.PENDING) {
            throw new BadRequestException('只有待处理状态的任务才能被完成');
        }

        const { notes } = completeProductionTaskDto;

        // 1. [修改] 汇总计算任务中所有产品的原料消耗
        // (Modified: Aggregate and calculate raw material consumption for all products in the task)
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
                item.quantity, // 使用每个任务项中定义的数量 (Use the quantity defined in each task item)
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

        // 2. 使用数据库事务来保证数据一致性
        // (Use a database transaction to ensure data consistency)
        return this.prisma.$transaction(async (tx) => {
            // 2.1 更新任务状态为“已完成”
            // (Update task status to "COMPLETED")
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            // 2.2 创建生产日志
            // (Create production log)
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    // [移除] 不再需要 actualQuantity
                    // (Removed: actualQuantity is no longer needed)
                    notes,
                },
            });

            // 2.3 遍历消耗列表，创建消耗日志并扣减库存
            // (Iterate through the consumption list, create consumption logs, and deduct stock)
            for (const consumption of finalConsumptions) {
                // 如果没有激活的SKU ID，说明是无需追踪的原料或未设置，直接跳过
                // (If there is no active SKU ID, it's an untracked or unset ingredient, so skip)
                if (!consumption.activeSkuId) {
                    continue;
                }

                // 创建原料消耗日志
                // (Create raw material consumption log)
                await tx.ingredientConsumptionLog.create({
                    data: {
                        productionLogId: productionLog.id,
                        ingredientId: consumption.ingredientId,
                        skuId: consumption.activeSkuId, // 记录消耗时使用的是哪个SKU (Record which SKU was used for consumption)
                        quantityInGrams: consumption.totalConsumed,
                    },
                });

                // 扣减对应激活SKU的实时库存
                // (Deduct the real-time stock of the corresponding active SKU)
                await tx.ingredientSKU.update({
                    where: { id: consumption.activeSkuId },
                    data: {
                        currentStockInGrams: {
                            decrement: consumption.totalConsumed,
                        },
                    },
                });
            }

            return this.findOne(tenantId, id);
        });
    }
}
