import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SkuStatus } from '@prisma/client';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { UpdateStockDto } from './dto/update-stock.dto'; // [新增] 导入更新库存的DTO
import { Prisma } from '@prisma/client'; // [核心修改] 导入Prisma，用于使用原生查询功能

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

    // [REFACTORED] findAll 方法现在使用数据库聚合查询，以解决性能问题
    async findAll(tenantId: string) {
        // 1. 过滤掉作为半成品的原料名称
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

        // 2. 查询基础原料信息
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                deletedAt: null,
                name: {
                    notIn: intermediateRecipeNames,
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

        const ingredientIds = ingredients.map((i) => i.id);
        if (ingredientIds.length === 0) {
            return [];
        }

        // 3. [核心性能优化] 使用原生SQL聚合查询，将计算任务交给数据库
        // 这个查询会连接消耗日志和生产日志，按原料ID分组，一次性计算出所有统计数据
        const consumptionStats: {
            ingredientId: string;
            total: number;
            taskCount: bigint; // Prisma返回的COUNT结果是BigInt类型
            firstDate: Date;
            lastDate: Date;
        }[] = await this.prisma.$queryRaw(
            Prisma.sql`
                SELECT
                    icl."ingredientId",
                    SUM(icl."quantityInGrams")::float AS total,
                    COUNT(DISTINCT pl."taskId") AS "taskCount",
                    MIN(pl."completedAt") AS "firstDate",
                    MAX(pl."completedAt") AS "lastDate"
                FROM
                    "IngredientConsumptionLog" AS icl
                JOIN
                    "ProductionLog" AS pl ON icl."productionLogId" = pl.id
                WHERE
                    icl."ingredientId" IN (${Prisma.join(ingredientIds)})
                GROUP BY
                    icl."ingredientId"
            `,
        );

        // 4. 将查询结果转换为Map，方便快速查找
        const statsMap = new Map(
            consumptionStats.map((stat) => [
                stat.ingredientId,
                {
                    ...stat,
                    taskCount: Number(stat.taskCount), // 将BigInt转换为Number
                },
            ]),
        );

        // 5. 将统计数据合并到原料信息中，计算最终结果
        return ingredients.map((ingredient) => {
            const stats = statsMap.get(ingredient.id);
            if (!stats || stats.total === 0) {
                return {
                    ...ingredient,
                    daysOfSupply: Infinity,
                    avgDailyConsumption: 0,
                    avgConsumptionPerTask: 0,
                    totalConsumptionInGrams: 0,
                };
            }

            const timeDiff = stats.lastDate.getTime() - stats.firstDate.getTime();
            const dayDiff = Math.max(1, Math.ceil(timeDiff / (1000 * 3600 * 24)));

            const avgDailyConsumption = stats.total / dayDiff;
            const daysOfSupply =
                avgDailyConsumption > 0 ? ingredient.currentStockInGrams / avgDailyConsumption : Infinity;
            const avgConsumptionPerTask = stats.taskCount > 0 ? stats.total / stats.taskCount : 0;

            return {
                ...ingredient,
                daysOfSupply,
                avgDailyConsumption,
                avgConsumptionPerTask,
                totalConsumptionInGrams: stats.total,
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
     * [新增] 更新原料的库存
     * @param tenantId 租户ID
     * @param id 原料ID
     * @param updateStockDto DTO，包含新的库存量
     */
    async updateStock(tenantId: string, id: string, updateStockDto: UpdateStockDto) {
        // 1. 确保该原料存在且属于该租户
        await this.findOne(tenantId, id);

        // 2. 更新库存
        return this.prisma.ingredient.update({
            where: { id },
            data: {
                currentStockInGrams: updateStockDto.currentStockInGrams,
            },
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
     * [核心修改] 创建采购记录并只更新原料的总库存
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
            });

            if (!sku) {
                throw new NotFoundException('SKU不存在');
            }

            // 2. 创建新的采购记录
            await tx.procurementRecord.create({
                data: {
                    skuId,
                    packagesPurchased: createProcurementDto.packagesPurchased,
                    pricePerPackage: createProcurementDto.pricePerPackage,
                    // 如果DTO中没有提供采购日期（补录情况），则使用当前时间
                    purchaseDate: createProcurementDto.purchaseDate || new Date(),
                },
            });

            // 3. 只更新原料的总库存
            return tx.ingredient.update({
                where: { id: sku.ingredientId },
                data: {
                    currentStockInGrams: {
                        increment: createProcurementDto.packagesPurchased * sku.specWeightInGrams,
                    },
                },
            });
        });
    }

    /**
     * [核心修改] 将删除采购记录改为修改采购记录
     * @param tenantId 租户ID
     * @param procurementId 采购记录ID
     * @param updateProcurementDto DTO
     */
    async updateProcurement(tenantId: string, procurementId: string, updateProcurementDto: UpdateProcurementDto) {
        // 1. 验证采购记录是否存在且属于该租户
        const procurement = await this.prisma.procurementRecord.findFirst({
            where: {
                id: procurementId,
                sku: {
                    ingredient: {
                        tenantId: tenantId,
                    },
                },
            },
        });

        if (!procurement) {
            throw new NotFoundException('采购记录不存在');
        }

        // 2. 仅更新采购记录的价格，不涉及库存变动
        return this.prisma.procurementRecord.update({
            where: { id: procurementId },
            data: {
                pricePerPackage: updateProcurementDto.pricePerPackage,
            },
        });
    }
}
