import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { Prisma, SkuStatus } from '@prisma/client';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { Decimal } from '@prisma/client/runtime/library';

@Injectable()
export class IngredientsService {
    constructor(private readonly prisma: PrismaService) {}

    // 创建原料品类
    async create(tenantId: string, createIngredientDto: CreateIngredientDto) {
        return this.prisma.ingredient.create({
            data: {
                ...createIngredientDto,
                tenantId,
            },
        });
    }

    // [REFACTORED] findAll 方法现在直接计算每日消耗和可供应天数
    async findAll(tenantId: string) {
        // [核心修改] 过滤掉作为半成品的原料（例如：烫种、卡仕达酱等）
        // 1. 首先找出所有类型为 PRE_DOUGH 或 EXTRA 的配方名称
        const intermediateRecipes = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                type: { in: ['PRE_DOUGH', 'EXTRA'] },
                deletedAt: null,
            },
            select: {
                name: true,
            },
        });
        const intermediateRecipeNames = intermediateRecipes.map((r) => r.name);

        // 2. 查询原料，并排除掉名称在上面列表中的原料
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                deletedAt: null,
                name: {
                    notIn: intermediateRecipeNames, // 过滤条件
                },
            },
            include: {
                activeSku: true,
                skus: {
                    orderBy: {
                        brand: 'asc',
                    },
                },
            },
            orderBy: {
                name: 'asc',
            },
        });

        // [ADDED] 为每个原料计算平均每日消耗和可供应天数
        const ingredientIds = ingredients.map((i) => i.id);
        if (ingredientIds.length === 0) {
            // 如果没有原料，直接返回空数组，避免后续计算
            return [];
        }

        const consumptionLogs = await this.prisma.ingredientConsumptionLog.findMany({
            where: {
                ingredientId: { in: ingredientIds },
            },
            select: {
                ingredientId: true,
                quantityInGrams: true,
                productionLog: {
                    // [FIXED] 同时查询 taskId 和 completedAt 以修复编译错误
                    select: {
                        completedAt: true,
                        taskId: true,
                    },
                },
            },
        });

        // 如果没有任何消耗记录，则所有原料的可供应天数都视为无限
        if (consumptionLogs.length === 0) {
            return ingredients.map((i) => ({
                ...i,
                daysOfSupply: Infinity,
                avgDailyConsumption: 0,
                avgConsumptionPerTask: 0,
                totalConsumptionInGrams: 0,
            }));
        }

        // 按原料ID对消耗记录进行分组和统计
        const consumptionStats = new Map<
            string,
            { total: number; count: number; firstDate: Date; lastDate: Date; taskIds: Set<string> }
        >();
        for (const log of consumptionLogs) {
            const stats = consumptionStats.get(log.ingredientId);
            const completedAt = log.productionLog.completedAt;

            if (!stats) {
                consumptionStats.set(log.ingredientId, {
                    total: log.quantityInGrams,
                    count: 1,
                    firstDate: completedAt,
                    lastDate: completedAt,
                    taskIds: new Set([log.productionLog.taskId]),
                });
            } else {
                stats.total += log.quantityInGrams;
                stats.count++;
                if (completedAt < stats.firstDate) stats.firstDate = completedAt;
                if (completedAt > stats.lastDate) stats.lastDate = completedAt;
                stats.taskIds.add(log.productionLog.taskId);
            }
        }

        return ingredients.map((ingredient) => {
            const stats = consumptionStats.get(ingredient.id);
            if (!stats || stats.total === 0) {
                return {
                    ...ingredient,
                    daysOfSupply: Infinity,
                    avgDailyConsumption: 0,
                    avgConsumptionPerTask: 0,
                    totalConsumptionInGrams: 0,
                };
            }

            // 计算消耗周期的天数（至少为1天，避免除以0）
            const timeDiff = stats.lastDate.getTime() - stats.firstDate.getTime();
            const dayDiff = Math.max(1, Math.ceil(timeDiff / (1000 * 3600 * 24)));

            const avgDailyConsumption = stats.total / dayDiff;
            const daysOfSupply =
                avgDailyConsumption > 0 ? ingredient.currentStockInGrams / avgDailyConsumption : Infinity;
            const avgConsumptionPerTask = stats.taskIds.size > 0 ? stats.total / stats.taskIds.size : 0;

            return {
                ...ingredient,
                daysOfSupply,
                avgDailyConsumption,
                avgConsumptionPerTask,
                totalConsumptionInGrams: stats.total, // [ADDED] 新增总消耗量字段
            };
        });
    }

    // 查询单个原料详情
    async findOne(tenantId: string, id: string) {
        const ingredient = await this.prisma.ingredient.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            include: {
                // V2.1 优化: 查询时总是包含激活的SKU信息
                activeSku: true,
                skus: {
                    include: {
                        procurementRecords: {
                            orderBy: {
                                purchaseDate: 'desc',
                            },
                        },
                    },
                    orderBy: {
                        brand: 'asc',
                    },
                },
            },
        });

        if (!ingredient) {
            throw new NotFoundException('原料不存在');
        }

        return ingredient;
    }

    // 更新原料品类信息
    async update(tenantId: string, id: string, updateIngredientDto: UpdateIngredientDto) {
        // 确保该原料存在且属于该租户
        await this.findOne(tenantId, id);
        return this.prisma.ingredient.update({
            where: { id },
            data: updateIngredientDto,
        });
    }

    /**
     * [V2.5 核心逻辑重写] 物理删除原料品类，增加使用校验
     * @param tenantId 租户ID
     * @param id 原料ID
     */
    async remove(tenantId: string, id: string) {
        // 1. 确保该原料存在且属于该租户
        const ingredientToDelete = await this.findOne(tenantId, id);

        // 2. 检查是否有任何配方正在使用该原料
        const usageInDoughs = await this.prisma.doughIngredient.count({
            where: {
                name: ingredientToDelete.name,
                dough: {
                    recipeVersion: {
                        family: {
                            tenantId,
                            deletedAt: null,
                        },
                    },
                },
            },
        });

        const usageInProducts = await this.prisma.productIngredient.count({
            where: {
                name: ingredientToDelete.name,
                product: {
                    recipeVersion: {
                        family: {
                            tenantId,
                            deletedAt: null,
                        },
                    },
                },
            },
        });

        if (usageInDoughs > 0 || usageInProducts > 0) {
            throw new BadRequestException('该原料正在被一个或多个配方使用，无法删除。');
        }

        // 3. [FIX] 使用事务按正确顺序删除所有关联记录
        return this.prisma.$transaction(async (tx) => {
            const skuIds = ingredientToDelete.skus.map((sku) => sku.id);

            if (skuIds.length > 0) {
                // 3.1 删除引用SKU的采购记录
                await tx.procurementRecord.deleteMany({
                    where: {
                        skuId: { in: skuIds },
                    },
                });
            }

            // 3.2 解除原料对激活SKU的引用
            await tx.ingredient.update({
                where: { id },
                data: { activeSkuId: null },
            });

            // 3.3 删除所有关联的SKU
            await tx.ingredientSKU.deleteMany({
                where: {
                    ingredientId: id,
                },
            });

            // 3.4 执行物理删除
            return tx.ingredient.delete({
                where: { id },
            });
        });
    }

    // 为原料创建新的SKU
    async createSku(tenantId: string, ingredientId: string, createSkuDto: CreateSkuDto) {
        // 确保该原料存在且属于该租户
        await this.findOne(tenantId, ingredientId);
        return this.prisma.ingredientSKU.create({
            data: {
                ...createSkuDto,
                ingredientId,
                // V2.1 优化: 新创建的SKU默认为未启用状态
                status: SkuStatus.INACTIVE,
            },
        });
    }

    /**
     * [V2.5 修改] 删除一个SKU，实现更灵活的删除逻辑
     * @param tenantId 租户ID
     * @param skuId SKU ID
     */
    async deleteSku(tenantId: string, skuId: string) {
        // 1. 验证SKU是否存在且属于该租户，并获取其关联信息
        const skuToDelete = await this.prisma.ingredientSKU.findFirst({
            where: {
                id: skuId,
                ingredient: {
                    tenantId: tenantId,
                },
            },
            include: {
                ingredient: true,
                _count: {
                    select: { procurementRecords: true },
                },
            },
        });

        if (!skuToDelete) {
            throw new NotFoundException('SKU不存在');
        }

        // 2. 业务规则：如果SKU是激活状态，则不允许删除
        if (skuToDelete.status === SkuStatus.ACTIVE) {
            throw new BadRequestException('不能删除当前激活的SKU，请先激活其他SKU。');
        }

        // 3. 检查其所属原料是否被配方使用
        const ingredientName = skuToDelete.ingredient.name;
        const usageInDoughs = await this.prisma.doughIngredient.count({
            where: {
                name: ingredientName,
                dough: { recipeVersion: { family: { tenantId, deletedAt: null } } },
            },
        });
        const usageInProducts = await this.prisma.productIngredient.count({
            where: {
                name: ingredientName,
                product: { recipeVersion: { family: { tenantId, deletedAt: null } } },
            },
        });

        const isIngredientInUse = usageInDoughs > 0 || usageInProducts > 0;
        const hasProcurementRecords = skuToDelete._count.procurementRecords > 0;

        // 4. 应用新的删除规则
        if (isIngredientInUse && hasProcurementRecords) {
            throw new BadRequestException('该SKU所属原料已被配方使用，且该SKU存在采购记录，无法删除。');
        }

        // 5. 执行删除
        return this.prisma.$transaction(async (tx) => {
            // 5.1 如果有采购记录，则一并删除
            if (hasProcurementRecords) {
                await tx.procurementRecord.deleteMany({
                    where: { skuId: skuId },
                });
            }
            // 5.2 删除SKU
            return tx.ingredientSKU.delete({
                where: { id: skuId },
            });
        });
    }

    /**
     * [V2.1 核心逻辑重写] 设置某个SKU为原料的激活SKU
     * @param tenantId 租户ID
     * @param ingredientId 原料ID
     * @param setActiveSkuDto DTO，包含skuId
     */
    async setActiveSku(tenantId: string, ingredientId: string, setActiveSkuDto: SetActiveSkuDto) {
        const { skuId } = setActiveSkuDto;

        // 1. 验证原料和目标SKU是否存在且属于该租户
        const ingredient = await this.findOne(tenantId, ingredientId);
        const skuToActivate = await this.prisma.ingredientSKU.findFirst({
            where: { id: skuId, ingredientId },
        });

        if (!skuToActivate) {
            throw new NotFoundException('指定的SKU不存在或不属于该原料');
        }

        // 如果目标SKU已经是激活状态，则无需任何操作
        if (ingredient.activeSkuId === skuId) {
            return ingredient;
        }

        // 2. 使用数据库事务来保证数据一致性
        return this.prisma.$transaction(async (tx) => {
            // 2.1 如果当前已有激活的SKU，则将其状态置为 INACTIVE
            if (ingredient.activeSkuId) {
                await tx.ingredientSKU.update({
                    where: { id: ingredient.activeSkuId },
                    data: { status: SkuStatus.INACTIVE },
                });
            }

            // 2.2 将新的SKU状态置为 ACTIVE
            await tx.ingredientSKU.update({
                where: { id: skuId },
                data: { status: SkuStatus.ACTIVE },
            });

            // 2.3 更新原料品类，将其 activeSkuId 指向新的SKU
            const updatedIngredient = await tx.ingredient.update({
                where: { id: ingredientId },
                data: { activeSkuId: skuId },
                include: {
                    activeSku: true,
                },
            });

            return updatedIngredient;
        });
    }

    /**
     * [核心修改] 创建采购记录并更新原料的最新单位成本和总库存
     * @param tenantId 租户ID
     * @param skuId SKU ID
     * @param createProcurementDto DTO
     */
    async createProcurement(tenantId: string, skuId: string, createProcurementDto: CreateProcurementDto) {
        return this.prisma.$transaction(async (tx) => {
            // 1. 查找SKU及其关联的原料，并确保它属于该租户
            const sku = await tx.ingredientSKU.findFirst({
                where: {
                    id: skuId,
                    ingredient: {
                        tenantId,
                    },
                },
                include: {
                    ingredient: true,
                },
            });

            if (!sku) {
                throw new NotFoundException('SKU不存在');
            }

            // 2. 创建新的采购记录
            const newProcurement = await tx.procurementRecord.create({
                data: {
                    skuId,
                    ...createProcurementDto,
                },
            });

            // 3. 计算本次采购的单位成本（元/克）
            const currentPricePerGram = new Decimal(newProcurement.pricePerPackage).div(sku.specWeightInGrams);

            // 4. 更新原料的总库存和最新的单位成本
            return tx.ingredient.update({
                where: { id: sku.ingredientId },
                data: {
                    currentStockInGrams: {
                        increment: createProcurementDto.packagesPurchased * sku.specWeightInGrams,
                    },
                    currentPricePerGram: currentPricePerGram,
                },
            });
        });
    }

    /**
     * [核心修改] 删除采购记录并根据新的最新采购记录更新原料成本
     * @param tenantId 租户ID
     * @param procurementId 采购记录ID
     */
    async deleteProcurement(tenantId: string, procurementId: string) {
        return this.prisma.$transaction(async (tx) => {
            // 1. 查找要删除的采购记录，并确保它属于该租户
            const procurementToDelete = await tx.procurementRecord.findFirst({
                where: {
                    id: procurementId,
                    sku: {
                        ingredient: {
                            tenantId: tenantId,
                        },
                    },
                },
                include: {
                    sku: true,
                },
            });

            if (!procurementToDelete) {
                throw new NotFoundException('采购记录不存在');
            }
            const { sku } = procurementToDelete;
            const stockDecrease = procurementToDelete.packagesPurchased * sku.specWeightInGrams;

            // 2. 删除采购记录
            await tx.procurementRecord.delete({
                where: { id: procurementId },
            });

            // 3. 查找删除后最新的采购记录
            const latestProcurement = await tx.procurementRecord.findFirst({
                where: {
                    sku: {
                        ingredientId: sku.ingredientId,
                    },
                },
                orderBy: {
                    purchaseDate: 'desc',
                },
                include: {
                    sku: true,
                },
            });

            // 4. 根据最新的采购记录计算新的单位成本，如果没有记录则成本为0
            const newPricePerGram = latestProcurement
                ? new Decimal(latestProcurement.pricePerPackage).div(latestProcurement.sku.specWeightInGrams)
                : new Decimal(0);

            // 5. 更新原料的库存和当前单位成本
            return tx.ingredient.update({
                where: { id: sku.ingredientId },
                data: {
                    currentStockInGrams: {
                        decrement: stockDecrease,
                    },
                    currentPricePerGram: newPricePerGram,
                },
            });
        });
    }
}
