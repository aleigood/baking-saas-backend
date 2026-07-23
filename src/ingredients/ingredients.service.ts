import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CostingService } from 'src/costing/costing.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreatePriceRecordDto } from './dto/create-price-record.dto';
import { SkuStatus, Prisma, IngredientType } from '@prisma/client';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdatePriceRecordDto } from './dto/update-price-record.dto';
import { UpdateSkuDto } from './dto/update-sku.dto';
import { QueryConsumptionLedgerDto } from './dto/query-consumption-ledger.dto';
import { getUtcDayBounds } from 'src/common/utils/timezone.util';

@Injectable()
export class IngredientsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly costingService: CostingService,
    ) {}

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
            data.waterContent = new Prisma.Decimal(1);
            data.isFlour = false;
        }

        return this.prisma.ingredient.create({
            data,
        });
    }

    async findAll(tenantId: string) {
        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                deletedAt: null,
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
            };
        }

        const activeSkuIds = ingredients.map((i) => i.activeSkuId).filter(Boolean) as string[];
        const priceMap = new Map<string, Prisma.Decimal>();

        if (activeSkuIds.length > 0) {
            const latestPriceRecords: { skuId: string; pricePerPackage: Prisma.Decimal }[] = await this.prisma
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
            latestPriceRecords.forEach((p) => priceMap.set(p.skuId, p.pricePerPackage));
        }

        const ingredientIds = ingredients.map((i) => i.id);
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        // [核心修改] 简化 SQL，只查询 total (总消耗量)，移除了 taskCount, firstDate, lastDate
        const consumptionStats: {
            ingredientId: string;
            total: number;
        }[] = await this.prisma.$queryRaw(
            Prisma.sql`
                SELECT
                    icl."ingredientId",
                    SUM(icl."quantityInGrams")::float AS total
                FROM
                    "IngredientConsumptionLog" AS icl
                INNER JOIN
                    "ProductionLog" AS pl ON pl."id" = icl."productionLogId"
                INNER JOIN
                    "ProductionTask" AS pt ON pt."id" = pl."taskId"
                WHERE
                    icl."ingredientId" IN (${Prisma.join(ingredientIds)})
                    AND EXISTS (
                        SELECT 1
                        FROM "ProductionTaskItem" AS pti
                        INNER JOIN "Product" AS p ON p."id" = pti."productId"
                        INNER JOIN "RecipeVersion" AS rv ON rv."id" = p."recipeVersionId"
                        INNER JOIN "RecipeFamily" AS rf ON rf."id" = rv."familyId"
                        WHERE pti."taskId" = pt."id"
                            AND pti."role" = 'FINAL_PRODUCT'
                            AND rf."type" = 'MAIN'
                    )
                GROUP BY
                    icl."ingredientId"
            `,
        );
        const monthlyConsumptionStats: {
            ingredientId: string;
            total: number;
        }[] = await this.prisma.$queryRaw(
            Prisma.sql`
                SELECT
                    icl."ingredientId",
                    SUM(icl."quantityInGrams")::float AS total
                FROM
                    "IngredientConsumptionLog" AS icl
                INNER JOIN
                    "ProductionLog" AS pl ON pl."id" = icl."productionLogId"
                INNER JOIN
                    "ProductionTask" AS pt ON pt."id" = pl."taskId"
                WHERE
                    icl."ingredientId" IN (${Prisma.join(ingredientIds)})
                    AND pl."completedAt" >= ${monthStart}
                    AND EXISTS (
                        SELECT 1
                        FROM "ProductionTaskItem" AS pti
                        INNER JOIN "Product" AS p ON p."id" = pti."productId"
                        INNER JOIN "RecipeVersion" AS rv ON rv."id" = p."recipeVersionId"
                        INNER JOIN "RecipeFamily" AS rf ON rf."id" = rv."familyId"
                        WHERE pti."taskId" = pt."id"
                            AND pti."role" = 'FINAL_PRODUCT'
                            AND rf."type" = 'MAIN'
                    )
                GROUP BY
                    icl."ingredientId"
            `,
        );

        const statsMap = new Map(consumptionStats.map((stat) => [stat.ingredientId, stat.total]));
        const monthlyStatsMap = new Map(monthlyConsumptionStats.map((stat) => [stat.ingredientId, stat.total]));

        const processedIngredients = await Promise.all(
            ingredients.map(async (ingredient) => {
                const totalConsumptionInGrams =
                    ingredient.type === IngredientType.SELF_MADE ? 0 : statsMap.get(ingredient.id) || 0;
                const monthlyConsumptionInGrams =
                    ingredient.type === IngredientType.SELF_MADE ? 0 : monthlyStatsMap.get(ingredient.id) || 0;

                const currentPricePerPackage = ingredient.activeSkuId
                    ? priceMap.get(ingredient.activeSkuId) || new Prisma.Decimal(0)
                    : new Prisma.Decimal(0);

                let unitPricePerGram = 0;
                if (ingredient.type === IngredientType.SELF_MADE && ingredient.recipeFamilyId) {
                    try {
                        const recipeCost = await this.costingService.calculateRecipeCost(
                            tenantId,
                            ingredient.recipeFamilyId,
                            1000,
                        );
                        unitPricePerGram = recipeCost / 1000;
                    } catch {
                        unitPricePerGram = 0;
                    }
                } else if (ingredient.activeSkuId) {
                    const activeSku = ingredient.skus.find((s) => s.id === ingredient.activeSkuId);
                    if (activeSku && activeSku.specWeightInGrams.toNumber() > 0) {
                        unitPricePerGram = currentPricePerPackage.toNumber() / activeSku.specWeightInGrams.toNumber();
                    }
                }

                return {
                    ...ingredient,
                    currentPricePerPackage: currentPricePerPackage.toNumber(),
                    unitPricePerGram,
                    waterContent: ingredient.waterContent.toNumber(),
                    totalConsumptionInGrams,
                    monthlyConsumptionInGrams,
                };
            }),
        );

        const allIngredients = [...processedIngredients].sort(
            (a, b) => b.totalConsumptionInGrams - a.totalConsumptionInGrams,
        );

        return {
            allIngredients: allIngredients,
        };
    }

    async getEditorCatalog(tenantId: string) {
        const [presets, ingredients] = await Promise.all([
            this.prisma.ingredientPreset.findMany({
                where: { isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            }),
            this.prisma.ingredient.findMany({
                where: { tenantId, deletedAt: null },
                select: { id: true, name: true, isFlour: true, waterContent: true, type: true },
                orderBy: { name: 'asc' },
            }),
        ]);

        return {
            presets: presets.map((preset) => ({
                id: preset.id,
                name: preset.name,
                isFlour: preset.isFlour,
                waterContent: preset.waterContent.toNumber(),
            })),
            ingredients: ingredients.map((ingredient) => ({
                ...ingredient,
                waterContent: ingredient.waterContent.toNumber(),
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
                        priceRecords: {
                            orderBy: {
                                recordedAt: 'desc',
                            },
                        },
                    },
                    orderBy: {
                        brand: 'asc',
                    },
                },
                // [核心新增] 关联查询配方族信息
                recipeFamily: {
                    select: {
                        id: true,
                        name: true,
                        versions: {
                            where: { isActive: true },
                            select: {
                                id: true,
                                version: true,
                                products: {
                                    where: { deletedAt: null },
                                    take: 1, // 获取第一个产品作为代表（用于成本计算）
                                    select: { id: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!ingredient) {
            throw new NotFoundException('原料不存在');
        }

        let currentPricePerPackage = new Prisma.Decimal(0);
        if (ingredient.activeSkuId) {
            const latestPriceRecord = await this.prisma.priceRecord.findFirst({
                where: {
                    skuId: ingredient.activeSkuId,
                },
                orderBy: {
                    recordedAt: 'desc',
                },
            });
            if (latestPriceRecord) {
                currentPricePerPackage = latestPriceRecord.pricePerPackage;
            }
        }
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        let totalConsumptionInGrams = 0;
        let monthlyConsumptionInGrams = 0;

        let unitPricePerGram = 0;
        if (ingredient.type === IngredientType.SELF_MADE && ingredient.recipeFamilyId) {
            try {
                const recipeCost = await this.costingService.calculateRecipeCost(
                    tenantId,
                    ingredient.recipeFamilyId,
                    1000,
                );
                unitPricePerGram = recipeCost / 1000;
            } catch {
                unitPricePerGram = 0;
            }
        } else if (ingredient.activeSkuId) {
            const activeSku = ingredient.skus.find((s) => s.id === ingredient.activeSkuId);
            if (activeSku && activeSku.specWeightInGrams.toNumber() > 0) {
                unitPricePerGram = currentPricePerPackage.toNumber() / activeSku.specWeightInGrams.toNumber();
            }
        }

        // Fetch production records if it's SELF_MADE
        let productionRecords: {
            id: string;
            date: Date;
            details: string;
            change: number;
            operator: string;
        }[] = [];
        let monthlyProductionCount = 0;
        let monthlyProductionInGrams = 0;
        if (ingredient.type === IngredientType.SELF_MADE && ingredient.recipeFamilyId) {
            const taskItems = await this.prisma.productionTaskItem.findMany({
                where: {
                    role: 'FINAL_PRODUCT',
                    product: {
                        recipeVersion: {
                            familyId: ingredient.recipeFamilyId,
                        },
                    },
                    task: {
                        status: 'COMPLETED',
                    },
                },
                include: {
                    task: {
                        select: {
                            id: true,
                            startDate: true,
                            createdBy: {
                                select: {
                                    name: true,
                                },
                            },
                            log: {
                                select: {
                                    completedAt: true,
                                },
                            },
                        },
                    },
                },
                orderBy: {
                    task: {
                        startDate: 'desc',
                    },
                },
            });

            const uniqueDates = new Set<string>();
            productionRecords = taskItems.map((item) => {
                const quantityGrams = item.quantity.toNumber();
                const completedAt = item.task.log?.completedAt;
                const recordDate = completedAt || item.task.startDate;

                if (recordDate && recordDate >= monthStart) {
                    monthlyProductionInGrams += quantityGrams;
                    const dateStr = new Date(recordDate).toISOString().split('T')[0];
                    uniqueDates.add(dateStr);
                }
                return {
                    id: item.id,
                    date: recordDate,
                    details: `自制任务 (任务#${item.task.id.substring(0, 4)})`,
                    change: quantityGrams,
                    operator: item.task.createdBy?.name || '系统',
                };
            });
            monthlyProductionCount = uniqueDates.size;
        }

        if (ingredient.type !== IngredientType.SELF_MADE) {
            const totalConsumption = await this.prisma.ingredientConsumptionLog.aggregate({
                where: {
                    ingredientId: ingredient.id,
                    productionLog: {
                        task: {
                            items: {
                                some: {
                                    role: 'FINAL_PRODUCT',
                                    product: {
                                        recipeVersion: {
                                            family: {
                                                type: 'MAIN',
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                _sum: {
                    quantityInGrams: true,
                },
            });
            const monthlyConsumption = await this.prisma.ingredientConsumptionLog.aggregate({
                where: {
                    ingredientId: ingredient.id,
                    productionLog: {
                        completedAt: {
                            gte: monthStart,
                        },
                        task: {
                            items: {
                                some: {
                                    role: 'FINAL_PRODUCT',
                                    product: {
                                        recipeVersion: {
                                            family: {
                                                type: 'MAIN',
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                _sum: {
                    quantityInGrams: true,
                },
            });
            totalConsumptionInGrams = totalConsumption._sum.quantityInGrams?.toNumber() || 0;
            monthlyConsumptionInGrams = monthlyConsumption._sum.quantityInGrams?.toNumber() || 0;
        }

        return {
            ...ingredient,
            currentPricePerPackage: currentPricePerPackage.toNumber(),
            unitPricePerGram,
            productionRecords,
            monthlyProductionCount,
            monthlyProductionInGrams,
            waterContent: ingredient.waterContent.toNumber(),
            totalConsumptionInGrams,
            monthlyConsumptionInGrams,
            skus: ingredient.skus.map((sku) => {
                const { priceRecords, ...skuData } = sku;
                return {
                    ...skuData,
                    specWeightInGrams: sku.specWeightInGrams.toNumber(),
                    priceRecords: priceRecords.map((rec) => ({
                        id: rec.id,
                        packageCount: rec.packageCount,
                        pricePerPackage: rec.pricePerPackage.toNumber(),
                        recordedAt: rec.recordedAt,
                    })),
                };
            }),
        };
    }

    async update(tenantId: string, id: string, updateIngredientDto: UpdateIngredientDto) {
        const original = await this.findOne(tenantId, id);

        if (updateIngredientDto.type === 'SELF_MADE' && original.type !== 'SELF_MADE') {
            throw new BadRequestException('不能将普通原料修改为自制原料');
        }

        const data: Prisma.IngredientUpdateInput = { ...updateIngredientDto };
        if (updateIngredientDto.waterContent !== undefined) {
            data.waterContent = new Prisma.Decimal(updateIngredientDto.waterContent);
        }

        return this.prisma.ingredient.update({
            where: { id },
            data: data,
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

    async getConsumptionLedger(tenantId: string, ingredientId: string, query: QueryConsumptionLedgerDto) {
        await this.findOne(tenantId, ingredientId);

        const { page = '1', limit = '20', startDate, endDate, keyword, userId } = query;
        const pageNum = Math.max(1, Number(page) || 1);
        const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
        const skip = (pageNum - 1) * limitNum;

        const completedAtFilter: { gte?: Date; lte?: Date } = {};
        if (startDate) {
            const { start } = getUtcDayBounds(startDate);
            completedAtFilter.gte = start;
        }
        if (endDate) {
            const { end } = getUtcDayBounds(endDate);
            completedAtFilter.lte = end;
        }

        const where: Prisma.ProductionLogWhereInput = {
            consumptionLogs: {
                some: {
                    ingredientId,
                    ingredient: {
                        tenantId,
                        deletedAt: null,
                    },
                },
            },
            AND: [
                {
                    task: {
                        items: {
                            some: {
                                role: 'FINAL_PRODUCT',
                                product: {
                                    recipeVersion: {
                                        family: {
                                            type: 'MAIN',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                ...(userId
                    ? [
                          {
                              task: {
                                  createdById: userId,
                              },
                          },
                      ]
                    : []),
            ],
            ...(startDate || endDate
                ? {
                      completedAt: completedAtFilter,
                  }
                : {}),
            ...(keyword
                ? {
                      OR: [
                          {
                              task: {
                                  id: { contains: keyword, mode: 'insensitive' },
                              },
                          },
                          {
                              task: {
                                  items: {
                                      some: {
                                          product: {
                                              name: { contains: keyword, mode: 'insensitive' },
                                          },
                                      },
                                  },
                              },
                          },
                      ],
                  }
                : {}),
        };

        const [total, logs] = await this.prisma.$transaction([
            this.prisma.productionLog.count({ where }),
            this.prisma.productionLog.findMany({
                where,
                orderBy: {
                    completedAt: 'desc',
                },
                skip,
                take: limitNum,
                include: {
                    task: {
                        select: {
                            id: true,
                            createdBy: {
                                select: {
                                    name: true,
                                },
                            },
                            items: {
                                where: {
                                    role: 'FINAL_PRODUCT',
                                },
                                select: {
                                    quantity: true,
                                    product: {
                                        select: {
                                            name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                    consumptionLogs: {
                        where: {
                            ingredientId,
                        },
                        select: {
                            quantityInGrams: true,
                        },
                    },
                },
            }),
        ]);

        return {
            data: logs.map((log) => {
                const totalQuantity = log.consumptionLogs.reduce(
                    (sum, item) => sum + item.quantityInGrams.toNumber(),
                    0,
                );
                const operatorName = log.task.createdBy?.name || '未知';
                const taskNameFormatted = `任务#${log.task.id.substring(0, 4)} (${log.task.items.map((i) => i.product.name).join('、')})`;

                return {
                    id: log.id,
                    date: log.completedAt,
                    taskId: log.task.id,
                    operator: operatorName,
                    taskName: taskNameFormatted,
                    quantityInGrams: totalQuantity,
                    sku: null,
                    taskProducts: log.task.items.map((item) => ({
                        name: item.product.name,
                        quantity: item.quantity.toNumber(),
                    })),
                };
            }),
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
                specWeightInGrams: new Prisma.Decimal(createSkuDto.specWeightInGrams),
                ingredientId,
                status: SkuStatus.INACTIVE,
            },
        });
    }

    async updateSku(tenantId: string, skuId: string, updateSkuDto: UpdateSkuDto) {
        const skuToUpdate = await this.prisma.ingredientSKU.findFirst({
            where: {
                id: skuId,
                ingredient: {
                    tenantId: tenantId,
                },
            },
            include: {
                _count: {
                    select: { priceRecords: true },
                },
            },
        });

        if (!skuToUpdate) {
            throw new NotFoundException('SKU不存在');
        }

        const { specWeightInGrams } = updateSkuDto;
        const hasPriceRecords = skuToUpdate._count.priceRecords > 0;

        if (
            specWeightInGrams !== undefined &&
            !new Prisma.Decimal(specWeightInGrams).equals(skuToUpdate.specWeightInGrams)
        ) {
            if (hasPriceRecords) {
                throw new BadRequestException('该SKU已有价格记录，无法修改其规格重量。');
            }
        }

        const data: Prisma.IngredientSKUUpdateInput = {
            ...updateSkuDto,
            ...(specWeightInGrams !== undefined && {
                specWeightInGrams: new Prisma.Decimal(specWeightInGrams),
            }),
        };

        if (specWeightInGrams === undefined) {
            delete data.specWeightInGrams;
        }

        return this.prisma.ingredientSKU.update({
            where: { id: skuId },
            data: data,
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
                    select: { priceRecords: true },
                },
            },
        });

        if (!skuToDelete) {
            throw new NotFoundException('SKU不存在');
        }

        if (skuToDelete.status === SkuStatus.ACTIVE) {
            throw new BadRequestException('不能删除当前激活的SKU，请先激活其他SKU。');
        }

        const hasPriceRecords = skuToDelete._count.priceRecords > 0;
        if (hasPriceRecords) {
            throw new BadRequestException('该SKU存在价格记录，无法删除。');
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

    async createPriceRecord(
        tenantId: string,
        userId: string,
        skuId: string,
        createPriceRecordDto: CreatePriceRecordDto,
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

            const priceRecord = await tx.priceRecord.create({
                data: {
                    skuId,
                    packageCount: createPriceRecordDto.packageCount,
                    pricePerPackage: new Prisma.Decimal(createPriceRecordDto.pricePerPackage),
                    recordedAt: new Date(),
                    userId: userId,
                },
            });

            return priceRecord;
        });
    }

    async updatePriceRecord(tenantId: string, priceRecordId: string, updatePriceRecordDto: UpdatePriceRecordDto) {
        return this.prisma.$transaction(async (tx) => {
            const priceRecord = await tx.priceRecord.findFirst({
                where: {
                    id: priceRecordId,
                    sku: {
                        ingredient: {
                            tenantId: tenantId,
                        },
                    },
                },
            });

            if (!priceRecord) {
                throw new NotFoundException('价格记录不存在');
            }

            const newPrice = new Prisma.Decimal(updatePriceRecordDto.pricePerPackage);

            return tx.priceRecord.update({
                where: { id: priceRecordId },
                data: {
                    pricePerPackage: newPrice,
                },
            });
        });
    }
}
