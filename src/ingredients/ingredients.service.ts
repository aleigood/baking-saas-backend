import { BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SkuStatus, Prisma, IngredientType } from '@prisma/client'; // [修改] 导入Prisma和IngredientType
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';
// [核心新增] 导入分页查询 DTO
import { QueryLedgerDto } from './dto/query-ledger.dto';

@Injectable()
export class IngredientsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(tenantId: string, createIngredientDto: CreateIngredientDto) {
        const { name } = createIngredientDto;

        // [核心修改] 创建一个用于构建数据的对象
        const data: Prisma.IngredientCreateInput = {
            ...createIngredientDto,
            // [核心修复] 使用正确的 Prisma 关联数据语法
            tenant: {
                connect: {
                    id: tenantId,
                },
            },
        };

        // [核心修改] 如果原料是“水”，则覆盖其默认属性
        if (name === '水') {
            data.type = IngredientType.UNTRACKED; // 设置为非追踪类型
            data.waterContent = 100; // 设置含水量为100%
            data.isFlour = false; // 确保不被错误地标记为面粉
        }

        return this.prisma.ingredient.create({
            data,
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
            const totalConsumptionInGrams = stats?.total || 0;

            // [核心修改] 专门处理非追踪原料
            if (ingredient.type === IngredientType.UNTRACKED) {
                return {
                    ...ingredient,
                    daysOfSupply: Infinity,
                    avgDailyConsumption: 0,
                    avgConsumptionPerTask: 0,
                    totalConsumptionInGrams, // 仍然显示总消耗量
                };
            }

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
                totalConsumptionInGrams,
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
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            include: {
                _count: {
                    select: {
                        doughIngredients: true,
                        productIngredients: true,
                    },
                },
            },
        });

        if (!ingredientToDelete) {
            throw new NotFoundException('原料不存在或已被删除');
        }

        const usageCount = ingredientToDelete._count.doughIngredients + ingredientToDelete._count.productIngredients;

        if (usageCount > 0) {
            throw new BadRequestException('该原料正在被一个或多个配方使用，无法删除。');
        }

        // Soft delete the ingredient by setting the deletedAt field
        // and un-setting the active SKU
        return this.prisma.ingredient.update({
            where: { id },
            data: {
                deletedAt: new Date(),
                activeSkuId: null,
            },
        });
    }

    // [核心修改] 实现库存流水分页逻辑
    async getIngredientLedger(tenantId: string, ingredientId: string, query: QueryLedgerDto) {
        await this.findOne(tenantId, ingredientId);
        const { page = 1, limit = 10 } = query;
        const pageNum = Number(page);
        const limitNum = Number(limit);
        const skip = (pageNum - 1) * limitNum;

        const [procurements, consumptions, adjustments] = await Promise.all([
            this.prisma.procurementRecord.findMany({
                where: { sku: { ingredientId: ingredientId } },
                include: { sku: true, user: { select: { name: true, phone: true } } }, // [核心修改] 关联查询用户信息
            }),
            this.prisma.ingredientConsumptionLog.findMany({
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
            }),
            this.prisma.ingredientStockAdjustment.findMany({
                where: { ingredientId: ingredientId },
                include: { user: { select: { name: true, phone: true } } },
            }),
        ]);

        const procurementLedger = procurements.map((p) => ({
            date: p.purchaseDate,
            type: '采购入库',
            change: p.packagesPurchased * p.sku.specWeightInGrams,
            details: `采购 ${p.sku.brand || ''} ${p.sku.specName} × ${p.packagesPurchased}`,
            operator: p.user.name || p.user.phone, // [核心修改] 使用用户名作为操作人
        }));

        const consumptionLedger = consumptions.map((c) => ({
            date: c.productionLog.completedAt,
            type: '生产消耗',
            change: -c.quantityInGrams,
            details: `生产任务 #${c.productionLog.task.id.slice(0, 8)}`,
            operator: '系统',
        }));

        const adjustmentLedger = adjustments.map((a) => ({
            date: a.createdAt,
            // [核心修改] 根据变动量判断是“库存调整”还是“生产损耗”
            type: a.reason?.startsWith('生产损耗') ? '生产损耗' : '库存调整',
            change: a.changeInGrams,
            details: a.reason || '无原因',
            operator: a.user.name || a.user.phone,
        }));

        const ledger = [...procurementLedger, ...consumptionLedger, ...adjustmentLedger];
        ledger.sort((a, b) => b.date.getTime() - a.date.getTime());

        const paginatedData = ledger.slice(skip, skip + limitNum);
        const total = ledger.length;

        return {
            data: paginatedData,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                hasMore: pageNum * limitNum < total,
            },
        };
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

    // [核心修改] 函数签名增加 userId 参数
    async createProcurement(
        tenantId: string,
        userId: string,
        skuId: string,
        createProcurementDto: CreateProcurementDto,
    ) {
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
                    userId: userId, // [核心修改] 保存操作人ID
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
