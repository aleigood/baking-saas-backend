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
// [核心修改] 导入 LedgerEntry 接口
import { QueryLedgerDto, LedgerEntryType, LedgerEntry } from './dto/query-ledger.dto';

@Injectable()
export class IngredientsService {
    constructor(private readonly prisma: PrismaService) {}

    async create(tenantId: string, createIngredientDto: CreateIngredientDto) {
        const { name } = createIngredientDto;

        const data: Prisma.IngredientCreateInput = {
            ...createIngredientDto,
            tenant: {
                connect: {
                    id: tenantId,
                },
            },
        };

        if (name === '水') {
            data.type = IngredientType.UNTRACKED;
            data.waterContent = new Prisma.Decimal(1); // [核心修复] 转换为 Decimal
            data.isFlour = false;
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

        if (ingredients.length === 0) {
            return {
                allIngredients: [],
                lowStockIngredients: [],
            };
        }

        const activeSkuIds = ingredients.map((i) => i.activeSkuId).filter(Boolean) as string[];
        const priceMap = new Map<string, Prisma.Decimal>();

        if (activeSkuIds.length > 0) {
            const latestProcurements: { skuId: string; pricePerPackage: Prisma.Decimal }[] = await this.prisma
                .$queryRaw`
                SELECT p."skuId", p."pricePerPackage"
                FROM "ProcurementRecord" p
                INNER JOIN (
                    SELECT "skuId", MAX("purchaseDate") as max_date
                    FROM "ProcurementRecord"
                    WHERE "skuId" IN (${Prisma.join(activeSkuIds)})
                    GROUP BY "skuId"
                ) lp ON p."skuId" = lp."skuId" AND p."purchaseDate" = lp.max_date
            `;
            latestProcurements.forEach((p) => priceMap.set(p.skuId, p.pricePerPackage));
        }

        const ingredientIds = ingredients.map((i) => i.id);

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

        const processedIngredients = ingredients.map((ingredient) => {
            const stats = statsMap.get(ingredient.id);
            const totalConsumptionInGrams = stats?.total || 0;
            const currentPricePerPackage = ingredient.activeSkuId
                ? priceMap.get(ingredient.activeSkuId) || new Prisma.Decimal(0)
                : new Prisma.Decimal(0);

            if (ingredient.type === IngredientType.UNTRACKED) {
                return {
                    ...ingredient,
                    currentPricePerPackage: new Prisma.Decimal(0),
                    daysOfSupply: Infinity,
                    avgDailyConsumption: 0,
                    avgConsumptionPerTask: 0,
                    totalConsumptionInGrams,
                };
            }

            if (!stats || stats.total === 0) {
                return {
                    ...ingredient,
                    currentPricePerPackage: currentPricePerPackage,
                    daysOfSupply: Infinity,
                    avgDailyConsumption: 0,
                    avgConsumptionPerTask: 0,
                    totalConsumptionInGrams: 0,
                };
            }

            const timeDiff = stats.lastDate.getTime() - stats.firstDate.getTime();
            const dayDiff = Math.max(1, Math.ceil(timeDiff / (1000 * 3600 * 24)));
            const avgDailyConsumption = new Prisma.Decimal(stats.total).div(dayDiff);
            const daysOfSupply = avgDailyConsumption.gt(0)
                ? new Prisma.Decimal(ingredient.currentStockInGrams).div(avgDailyConsumption).toNumber()
                : Infinity;
            const avgConsumptionPerTask =
                stats.taskCount > 0 ? new Prisma.Decimal(stats.total).div(stats.taskCount).toNumber() : 0;

            return {
                ...ingredient,
                currentPricePerPackage: currentPricePerPackage,
                daysOfSupply,
                avgDailyConsumption: avgDailyConsumption.toNumber(),
                avgConsumptionPerTask,
                totalConsumptionInGrams,
            };
        });

        const allIngredients = [...processedIngredients].sort(
            (a, b) => b.totalConsumptionInGrams - a.totalConsumptionInGrams,
        );
        const lowStockIngredients = [...processedIngredients]
            .filter(
                (ing) =>
                    ing.type === 'STANDARD' &&
                    (ing.daysOfSupply < 7 || new Prisma.Decimal(ing.currentStockInGrams).lessThanOrEqualTo(0)),
            )
            .sort((a, b) => a.daysOfSupply - b.daysOfSupply);

        return {
            allIngredients: allIngredients.map((ing) => ({
                ...ing,
                currentPricePerPackage: ing.currentPricePerPackage.toNumber(),
                currentStockInGrams: ing.currentStockInGrams.toNumber(),
                currentStockValue: ing.currentStockValue.toNumber(),
                waterContent: ing.waterContent.toNumber(),
            })),
            lowStockIngredients: lowStockIngredients.map((ing) => ({
                ...ing,
                currentPricePerPackage: ing.currentPricePerPackage.toNumber(),
                currentStockInGrams: ing.currentStockInGrams.toNumber(),
                currentStockValue: ing.currentStockValue.toNumber(),
                waterContent: ing.waterContent.toNumber(),
            })),
        };
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

        let currentPricePerPackage = new Prisma.Decimal(0);
        if (ingredient.activeSkuId) {
            const latestProcurement = await this.prisma.procurementRecord.findFirst({
                where: {
                    skuId: ingredient.activeSkuId,
                },
                orderBy: {
                    purchaseDate: 'desc',
                },
            });
            if (latestProcurement) {
                currentPricePerPackage = latestProcurement.pricePerPackage;
            }
        }

        return {
            ...ingredient,
            currentPricePerPackage: currentPricePerPackage.toNumber(),
        };
    }

    async update(tenantId: string, id: string, updateIngredientDto: UpdateIngredientDto) {
        await this.findOne(tenantId, id);

        // [核心修复] 对所有 number 类型的 Decimal 字段进行转换
        const data: Prisma.IngredientUpdateInput = { ...updateIngredientDto };
        if (updateIngredientDto.waterContent !== undefined) {
            data.waterContent = new Prisma.Decimal(updateIngredientDto.waterContent);
        }

        return this.prisma.ingredient.update({
            where: { id },
            data: data,
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

            const { changeInGrams, reason, initialCostPerKg } = adjustStockDto;

            await tx.ingredientStockAdjustment.create({
                data: {
                    ingredientId: id,
                    userId,
                    changeInGrams: new Prisma.Decimal(changeInGrams), // [核心修复] 转换为 Decimal
                    reason,
                },
            });

            const oldStock = new Prisma.Decimal(ingredient.currentStockInGrams);
            const oldStockValue = new Prisma.Decimal(ingredient.currentStockValue);
            let valueChange = new Prisma.Decimal(0);

            if (oldStock.isZero() && changeInGrams > 0) {
                if (!initialCostPerKg || initialCostPerKg <= 0) {
                    throw new BadRequestException('期初库存录入必须提供一个有效的初始单价(元/kg)。');
                }
                valueChange = new Prisma.Decimal(initialCostPerKg).mul(changeInGrams).div(1000);
            } else if (!oldStock.isZero()) {
                const avgCostPerGram = oldStockValue.div(oldStock);
                valueChange = avgCostPerGram.mul(changeInGrams);
            } else {
                valueChange = new Prisma.Decimal(0);
            }

            const newStockValue = oldStockValue.add(valueChange);
            if (newStockValue.isNegative()) {
                await tx.ingredient.update({
                    where: { id },
                    data: {
                        currentStockValue: 0,
                        currentStockInGrams: {
                            increment: changeInGrams,
                        },
                    },
                });
            } else {
                await tx.ingredient.update({
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
            }

            return tx.ingredient.findUnique({ where: { id } });
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
                        componentIngredients: true,
                        productIngredients: true,
                    },
                },
            },
        });

        if (!ingredientToDelete) {
            throw new NotFoundException('原料不存在或已被删除');
        }

        const usageCount =
            ingredientToDelete._count.componentIngredients + ingredientToDelete._count.productIngredients;

        if (usageCount > 0) {
            throw new BadRequestException('该原料正在被一个或多个配方使用，无法删除。');
        }

        return this.prisma.ingredient.update({
            where: { id },
            data: {
                deletedAt: new Date(),
                activeSkuId: null,
            },
        });
    }

    async getIngredientLedger(tenantId: string, ingredientId: string, query: QueryLedgerDto) {
        await this.findOne(tenantId, ingredientId);
        const { page = 1, limit = 10, type, userId, startDate, endDate, keyword } = query;
        const pageNum = Number(page);
        const limitNum = Number(limit);
        const skip = (pageNum - 1) * limitNum;

        const dateFilter: { gte?: Date; lte?: Date } = {};
        if (startDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            dateFilter.gte = start;
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.lte = end;
        }
        const hasDateFilter = startDate || endDate;

        const ledger: LedgerEntry[] = [];

        if (!type || type === LedgerEntryType.PROCUREMENT) {
            const procurements = await this.prisma.procurementRecord.findMany({
                where: {
                    sku: { ingredientId: ingredientId },
                    ...(userId && { userId: userId }),
                    ...(hasDateFilter && { purchaseDate: dateFilter }),
                    ...(keyword && {
                        OR: [
                            { sku: { brand: { contains: keyword, mode: 'insensitive' } } },
                            { sku: { specName: { contains: keyword, mode: 'insensitive' } } },
                            { user: { name: { contains: keyword, mode: 'insensitive' } } },
                        ],
                    }),
                },
                include: { sku: true, user: { select: { name: true, phone: true } } },
            });
            const procurementLedger: LedgerEntry[] = procurements.map((p) => ({
                date: p.purchaseDate,
                type: '采购入库',
                change: new Prisma.Decimal(p.packagesPurchased).mul(p.sku.specWeightInGrams).toNumber(),
                details: `采购 ${p.sku.brand || ''} ${p.sku.specName} × ${p.packagesPurchased}`,
                operator: p.user.name || p.user.phone,
            }));
            ledger.push(...procurementLedger);
        }

        if ((!type || type === LedgerEntryType.CONSUMPTION) && !userId) {
            const consumptions = await this.prisma.ingredientConsumptionLog.findMany({
                where: {
                    ingredientId: ingredientId,
                    ...(hasDateFilter && { productionLog: { completedAt: dateFilter } }),
                    ...(keyword && {
                        productionLog: {
                            task: { id: { contains: keyword, mode: 'insensitive' } },
                        },
                    }),
                },
                include: {
                    productionLog: {
                        include: {
                            task: {
                                select: { id: true },
                            },
                        },
                    },
                },
            });
            const consumptionLedger: LedgerEntry[] = consumptions.map((c) => ({
                date: c.productionLog.completedAt,
                type: '生产消耗',
                change: -c.quantityInGrams.toNumber(),
                details: `生产任务 #${c.productionLog.task.id.slice(0, 8)}`,
                operator: '系统',
            }));
            ledger.push(...consumptionLedger);
        }

        if (!type || type === LedgerEntryType.ADJUSTMENT || type === LedgerEntryType.SPOILAGE) {
            const adjustments = await this.prisma.ingredientStockAdjustment.findMany({
                where: {
                    ingredientId: ingredientId,
                    ...(userId && { userId: userId }),
                    ...(hasDateFilter && { createdAt: dateFilter }),
                    ...(keyword && {
                        OR: [
                            { reason: { contains: keyword, mode: 'insensitive' } },
                            { user: { name: { contains: keyword, mode: 'insensitive' } } },
                        ],
                    }),
                },
                include: { user: { select: { name: true, phone: true } } },
            });

            let adjustmentLedger: LedgerEntry[] = adjustments.map((a) => ({
                date: a.createdAt,
                type: a.reason?.startsWith('生产损耗') ? '生产损耗' : '库存调整',
                change: a.changeInGrams.toNumber(),
                details: a.reason || '无原因',
                operator: a.user.name || a.user.phone,
            }));

            if (type === LedgerEntryType.ADJUSTMENT) {
                adjustmentLedger = adjustmentLedger.filter((a) => a.type === '库存调整');
            }
            if (type === LedgerEntryType.SPOILAGE) {
                adjustmentLedger = adjustmentLedger.filter((a) => a.type === '生产损耗');
            }

            ledger.push(...adjustmentLedger);
        }

        ledger.sort((a, b) => b.date.getTime() - a.date.getTime());

        const total = ledger.length;
        const paginatedData = ledger.slice(skip, skip + limitNum);

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
                specWeightInGrams: new Prisma.Decimal(createSkuDto.specWeightInGrams), // [核心修复] 转换为 Decimal
                ingredientId,
                status: SkuStatus.INACTIVE,
            },
        });
    }

    async deleteSku(tenantId: string, skuId: string) {
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

        if (skuToDelete.status === SkuStatus.ACTIVE) {
            throw new BadRequestException('不能删除当前激活的SKU，请先激活其他SKU。');
        }

        const hasProcurementRecords = skuToDelete._count.procurementRecords > 0;
        if (hasProcurementRecords) {
            throw new BadRequestException('该SKU存在采购记录，无法删除。');
        }

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

            const procurement = await tx.procurementRecord.create({
                data: {
                    skuId,
                    packagesPurchased: createProcurementDto.packagesPurchased,
                    pricePerPackage: new Prisma.Decimal(createProcurementDto.pricePerPackage), // [核心修复] 转换为 Decimal
                    purchaseDate: new Date(),
                    userId: userId,
                },
            });

            const purchaseValue = new Prisma.Decimal(createProcurementDto.pricePerPackage).mul(
                createProcurementDto.packagesPurchased,
            );

            await tx.ingredient.update({
                where: { id: sku.ingredientId },
                data: {
                    currentStockInGrams: {
                        increment: new Prisma.Decimal(createProcurementDto.packagesPurchased).mul(
                            sku.specWeightInGrams,
                        ),
                    },
                    currentStockValue: {
                        increment: purchaseValue,
                    },
                },
            });

            return procurement;
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
                    pricePerPackage: newPrice, // [核心修复] 使用 Decimal 对象进行更新
                },
            });
        });
    }
}
