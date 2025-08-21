import { BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SkuStatus } from '@prisma/client';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class IngredientsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(tenantId: string, createIngredientDto: CreateIngredientDto) {
        return this.prisma.ingredient.create({
            data: {
                ...createIngredientDto,
                tenantId,
            },
        });
    }

    async findAll(tenantId: string) {
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

        const consumptionStats: {
            ingredientId: string;
            total: number;
            taskCount: bigint;
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

        const statsMap = new Map(
            consumptionStats.map((stat) => [
                stat.ingredientId,
                {
                    ...stat,
                    taskCount: Number(stat.taskCount),
                },
            ]),
        );

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

    async findOne(tenantId: string, id: string) {
        const ingredient = await this.prisma.ingredient.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            include: {
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

    async update(tenantId: string, id: string, updateIngredientDto: UpdateIngredientDto) {
        await this.findOne(tenantId, id);
        return this.prisma.ingredient.update({
            where: { id },
            data: updateIngredientDto,
        });
    }

    async adjustStock(tenantId: string, id: string, userId: string, adjustStockDto: AdjustStockDto) {
        const member = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { userId, tenantId } },
        });

        if (!member || (member.role !== 'OWNER' && member.role !== 'ADMIN')) {
            throw new ForbiddenException('您没有权限调整库存。');
        }

        return this.prisma.$transaction(async (tx) => {
            const ingredient = await tx.ingredient.findFirst({
                where: { id, tenantId },
            });

            if (!ingredient) {
                throw new NotFoundException('原料不存在');
            }

            const { changeInGrams, reason } = adjustStockDto;

            await tx.ingredientStockAdjustment.create({
                data: {
                    ingredientId: id,
                    userId,
                    changeInGrams,
                    reason,
                },
            });

            const oldStock = ingredient.currentStockInGrams;
            const oldStockValue = new Prisma.Decimal(ingredient.currentStockValue.toString());
            let valueChange = new Prisma.Decimal(0);

            if (oldStock > 0) {
                const avgCostPerGram = oldStockValue.div(oldStock);
                valueChange = avgCostPerGram.mul(changeInGrams);
            }

            return tx.ingredient.update({
                where: { id },
                data: {
                    currentStockInGrams: {
                        increment: changeInGrams,
                    },
                    currentStockValue: {
                        increment: valueChange,
                    },
                },
            });
        });
    }

    async remove(tenantId: string, id: string) {
        const ingredientToDelete = await this.prisma.ingredient.findFirst({
            where: { id, tenantId },
            include: {
                _count: {
                    select: {
                        doughIngredients: true,
                        productIngredients: true,
                    },
                },
                skus: true,
            },
        });

        if (!ingredientToDelete) {
            throw new NotFoundException('原料不存在');
        }

        const usageCount = ingredientToDelete._count.doughIngredients + ingredientToDelete._count.productIngredients;

        if (usageCount > 0) {
            throw new BadRequestException('该原料正在被一个或多个配方使用，无法删除。');
        }

        return this.prisma.$transaction(async (tx) => {
            const skuIds = ingredientToDelete.skus.map((sku) => sku.id);

            if (skuIds.length > 0) {
                await tx.procurementRecord.deleteMany({
                    where: {
                        skuId: { in: skuIds },
                    },
                });
            }

            await tx.ingredient.update({
                where: { id },
                data: { activeSkuId: null },
            });

            await tx.ingredientSKU.deleteMany({
                where: {
                    ingredientId: id,
                },
            });

            return tx.ingredient.delete({
                where: { id },
            });
        });
    }

    async getIngredientLedger(tenantId: string, ingredientId: string) {
        await this.findOne(tenantId, ingredientId);

        const procurements = await this.prisma.procurementRecord.findMany({
            where: { sku: { ingredientId: ingredientId } },
            include: { sku: true },
            orderBy: { purchaseDate: 'desc' },
        });

        const consumptions = await this.prisma.ingredientConsumptionLog.findMany({
            where: { ingredientId: ingredientId },
            include: {
                productionLog: {
                    include: {
                        task: {
                            select: { id: true },
                        },
                    },
                },
            },
            orderBy: { productionLog: { completedAt: 'desc' } },
        });

        const adjustments = await this.prisma.ingredientStockAdjustment.findMany({
            where: { ingredientId: ingredientId },
            include: { user: { select: { name: true, phone: true } } },
            orderBy: { createdAt: 'desc' },
        });

        const procurementLedger = procurements.map((p) => ({
            date: p.purchaseDate,
            type: '采购入库',
            change: p.packagesPurchased * p.sku.specWeightInGrams,
            details: `采购 ${p.sku.brand || ''} ${p.sku.specName} × ${p.packagesPurchased}`,
            operator: '系统',
        }));

        const consumptionLedger = consumptions.map((c) => ({
            date: c.productionLog.completedAt,
            type: '生产消耗',
            change: -c.quantityInGrams,
            details: `生产任务 #${c.productionLog.task.id.split('-')[0]}`,
            operator: '系统',
        }));

        const adjustmentLedger = adjustments.map((a) => ({
            date: a.createdAt,
            type: '库存调整',
            change: a.changeInGrams,
            details: a.reason || '无原因',
            operator: a.user.name || a.user.phone,
        }));

        const ledger = [...procurementLedger, ...consumptionLedger, ...adjustmentLedger];
        ledger.sort((a, b) => b.date.getTime() - a.date.getTime());

        return ledger;
    }

    async createSku(tenantId: string, ingredientId: string, createSkuDto: CreateSkuDto) {
        await this.findOne(tenantId, ingredientId);
        return this.prisma.ingredientSKU.create({
            data: {
                ...createSkuDto,
                ingredientId,
                status: SkuStatus.INACTIVE,
            },
        });
    }

    /**
     * [核心修改] 简化删除SKU的业务逻辑
     * @param tenantId 租户ID
     * @param skuId SKU ID
     */
    async deleteSku(tenantId: string, skuId: string) {
        // 1. 验证SKU是否存在且属于该租户
        const skuToDelete = await this.prisma.ingredientSKU.findFirst({
            where: {
                id: skuId,
                ingredient: {
                    tenantId: tenantId,
                },
            },
            include: {
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

        // 3. [核心修改] 应用新的、更简单的删除规则
        const hasProcurementRecords = skuToDelete._count.procurementRecords > 0;
        if (hasProcurementRecords) {
            throw new BadRequestException('该SKU存在采购记录，无法删除。');
        }

        // 4. 执行删除 (由于没有采购记录，无需再处理关联的采购记录)
        return this.prisma.ingredientSKU.delete({
            where: { id: skuId },
        });
    }

    async setActiveSku(tenantId: string, ingredientId: string, setActiveSkuDto: SetActiveSkuDto) {
        const { skuId } = setActiveSkuDto;

        const ingredient = await this.findOne(tenantId, ingredientId);
        const skuToActivate = await this.prisma.ingredientSKU.findFirst({
            where: { id: skuId, ingredientId },
        });

        if (!skuToActivate) {
            throw new NotFoundException('指定的SKU不存在或不属于该原料');
        }

        if (ingredient.activeSkuId === skuId) {
            return ingredient;
        }

        return this.prisma.$transaction(async (tx) => {
            if (ingredient.activeSkuId) {
                await tx.ingredientSKU.update({
                    where: { id: ingredient.activeSkuId },
                    data: { status: SkuStatus.INACTIVE },
                });
            }

            await tx.ingredientSKU.update({
                where: { id: skuId },
                data: { status: SkuStatus.ACTIVE },
            });

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

    async createProcurement(tenantId: string, skuId: string, createProcurementDto: CreateProcurementDto) {
        return this.prisma.$transaction(async (tx) => {
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

            await tx.procurementRecord.create({
                data: {
                    skuId,
                    packagesPurchased: createProcurementDto.packagesPurchased,
                    pricePerPackage: createProcurementDto.pricePerPackage,
                    purchaseDate: createProcurementDto.purchaseDate || new Date(),
                },
            });

            const purchaseValue = new Prisma.Decimal(createProcurementDto.pricePerPackage).mul(
                createProcurementDto.packagesPurchased,
            );

            return tx.ingredient.update({
                where: { id: sku.ingredientId },
                data: {
                    currentStockInGrams: {
                        increment: createProcurementDto.packagesPurchased * sku.specWeightInGrams,
                    },
                    currentStockValue: {
                        increment: purchaseValue,
                    },
                },
            });
        });
    }

    async updateProcurement(tenantId: string, procurementId: string, updateProcurementDto: UpdateProcurementDto) {
        return this.prisma.$transaction(async (tx) => {
            const procurement = await tx.procurementRecord.findFirst({
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

            if (!procurement) {
                throw new NotFoundException('采购记录不存在');
            }

            const oldPrice = new Prisma.Decimal(procurement.pricePerPackage.toString());
            const newPrice = new Prisma.Decimal(updateProcurementDto.pricePerPackage);
            const priceDifference = newPrice.sub(oldPrice).mul(procurement.packagesPurchased);

            await tx.ingredient.update({
                where: { id: procurement.sku.ingredientId },
                data: {
                    currentStockValue: {
                        increment: priceDifference,
                    },
                },
            });

            return tx.procurementRecord.update({
                where: { id: procurementId },
                data: {
                    pricePerPackage: updateProcurementDto.pricePerPackage,
                },
            });
        });
    }
}
