import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
// [FIX] 导入 Prisma 类型以增强类型安全
import { Prisma, ProductionTaskStatus } from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService } from '../costing/costing.service';

@Injectable()
export class ProductionTasksService {
    constructor(
        private readonly prisma: PrismaService,
        // 注入成本计算服务，用于获取配方成分
        private readonly costingService: CostingService,
    ) {}

    /**
     * [V2.1 逻辑修改] 创建生产任务
     * @param tenantId 租户ID
     * @param createProductionTaskDto DTO
     */
    async create(tenantId: string, createProductionTaskDto: CreateProductionTaskDto) {
        const { productId, quantity, unit, plannedDate, notes } = createProductionTaskDto;

        // 验证目标产品是否存在且属于该租户
        const product = await this.prisma.product.findFirst({
            where: {
                id: productId,
                recipeVersion: {
                    family: {
                        tenantId,
                    },
                },
            },
        });

        if (!product) {
            throw new NotFoundException('目标产品不存在');
        }

        // [FIX] 当使用 connect 关联一个字段时，其他关联字段也需要使用 connect
        const data: Prisma.ProductionTaskCreateInput = {
            quantity,
            unit,
            plannedDate,
            notes,
            tenant: {
                connect: {
                    id: tenantId,
                },
            },
            product: {
                connect: {
                    id: productId,
                },
            },
        };

        return this.prisma.productionTask.create({
            data,
        });
    }

    // 查询生产任务列表
    async findAll(tenantId: string, query: QueryProductionTaskDto) {
        const { status, plannedDate } = query;
        // [FIX] 为 'where' 对象提供精确的 Prisma 类型，以解决所有相关的 ESLint 错误
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
            orderBy: {
                plannedDate: 'asc',
            },
        });
    }

    // 查询单个生产任务详情
    async findOne(tenantId: string, id: string) {
        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
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
    async update(tenantId: string, id: string, updateProductionTaskDto: UpdateProductionTaskDto) {
        await this.findOne(tenantId, id);
        return this.prisma.productionTask.update({
            where: { id },
            data: updateProductionTaskDto,
        });
    }

    // 软删除生产任务
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
     * [V2.1 核心逻辑重写] 完成生产任务，记录日志并扣减库存
     * @param tenantId 租户ID
     * @param id 任务ID
     * @param completeProductionTaskDto DTO
     */
    async complete(tenantId: string, id: string, completeProductionTaskDto: CompleteProductionTaskDto) {
        const task = await this.findOne(tenantId, id);

        if (task.status !== ProductionTaskStatus.PENDING) {
            throw new BadRequestException('只有待处理状态的任务才能被完成');
        }

        const { actualQuantity, notes } = completeProductionTaskDto;

        // 1. 获取该产品配方的所有原料消耗明细
        const consumptions = await this.costingService.calculateProductConsumptions(
            tenantId,
            task.productId,
            actualQuantity,
        );

        // 2. 使用数据库事务来保证数据一致性
        return this.prisma.$transaction(async (tx) => {
            // 2.1 更新任务状态为“已完成”
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            // 2.2 创建生产日志
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    actualQuantity,
                    notes,
                },
            });

            // 2.3 遍历消耗列表，创建消耗日志并扣减库存
            for (const consumption of consumptions) {
                // 如果没有激活的SKU ID，说明是无需追踪的原料或未设置，直接跳过
                if (!consumption.activeSkuId) {
                    continue;
                }

                // 创建原料消耗日志
                await tx.ingredientConsumptionLog.create({
                    data: {
                        productionLogId: productionLog.id,
                        ingredientId: consumption.ingredientId,
                        skuId: consumption.activeSkuId, // 记录消耗时使用的是哪个SKU
                        quantityInGrams: consumption.totalConsumed,
                    },
                });

                // 扣减对应激活SKU的实时库存
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
