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

// [核心删除] 移除本地的 LedgerEntry 接口定义，因为它已被移至 DTO 文件

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
            data.waterContent = 1; // [核心修改] 设置含水量为1 (代表100%)
            data.isFlour = false; // 确保不被错误地标记为面粉
        }

        return this.prisma.ingredient.create({
            data,
        });
    }

    // [核心重构] 修改 findAll 方法，使其返回分类和排序后的数据
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
                : new Prisma.Decimal(0); // [核心修复] 确保是 Decimal

            if (ingredient.type === IngredientType.UNTRACKED) {
                return {
                    ...ingredient,
                    currentPricePerPackage: new Prisma.Decimal(0), // [核心修复] 确保是 Decimal
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
            const avgDailyConsumption = new Prisma.Decimal(stats.total).div(dayDiff); // [核心修复] 使用 Decimal 计算
            // [核心修复] TS2362: 使用 Decimal.js 方法进行高精度除法运算
            const daysOfSupply = avgDailyConsumption.gt(0)
                ? new Prisma.Decimal(ingredient.currentStockInGrams).div(avgDailyConsumption).toNumber()
                : Infinity;
            const avgConsumptionPerTask =
                stats.taskCount > 0 ? new Prisma.Decimal(stats.total).div(stats.taskCount).toNumber() : 0; // [核心修复] 使用 Decimal 计算

            return {
                ...ingredient,
                currentPricePerPackage: currentPricePerPackage,
                daysOfSupply,
                avgDailyConsumption: avgDailyConsumption.toNumber(),
                avgConsumptionPerTask,
                totalConsumptionInGrams,
            };
        });

        // 在服务端进行分类和排序
        const allIngredients = [...processedIngredients].sort(
            (a, b) => b.totalConsumptionInGrams - a.totalConsumptionInGrams,
        );
        const lowStockIngredients = [...processedIngredients]
            // [核心修复] TS2365: 修复方法名为 lessThanOrEqualTo
            .filter(
                (ing) =>
                    ing.type === 'STANDARD' &&
                    (ing.daysOfSupply < 7 || new Prisma.Decimal(ing.currentStockInGrams).lessThanOrEqualTo(0)),
            )
            .sort((a, b) => a.daysOfSupply - b.daysOfSupply);

        return {
            // [核心修复] 返回给前端前将所有 Decimal 转换为 number
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

        // [核心新增] 为单个原料查询附加最新的采购单价
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
        return this.prisma.ingredient.update({
            where: { id },
            data: updateIngredientDto,
        });
    }

    // [核心改造] 彻底重构库存调整逻辑，以支持期初成本录入并确保加权平均法准确性
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

            // 记录原始流水，无论如何都执行
            await tx.ingredientStockAdjustment.create({
                data: {
                    ingredientId: id,
                    userId,
                    changeInGrams,
                    reason,
                },
            });

            const oldStock = new Prisma.Decimal(ingredient.currentStockInGrams);
            const oldStockValue = new Prisma.Decimal(ingredient.currentStockValue);
            let valueChange = new Prisma.Decimal(0);

            // 场景1: 期初库存录入 (库存从0开始增加)
            if (oldStock.isZero() && changeInGrams > 0) {
                if (!initialCostPerKg || initialCostPerKg <= 0) {
                    throw new BadRequestException('期初库存录入必须提供一个有效的初始单价(元/kg)。');
                }
                // 根据初始单价计算初始库存总价值
                valueChange = new Prisma.Decimal(initialCostPerKg).mul(changeInGrams).div(1000);
            }
            // 场景2: 非期初的库存调整 (增加或减少)
            else if (!oldStock.isZero()) {
                // 计算当前的平均每克成本
                const avgCostPerGram = oldStockValue.div(oldStock);
                // 根据平均成本计算价值变动
                valueChange = avgCostPerGram.mul(changeInGrams);
            }
            // 场景3: 库存为0时减少库存 (逻辑上不可能，但作为保护) 或增加0库存，价值不变
            else {
                valueChange = new Prisma.Decimal(0);
            }

            // [核心逻辑] 确保扣减后库存价值不会小于0
            const newStockValue = oldStockValue.add(valueChange);
            if (newStockValue.isNegative()) {
                // 如果计算出的新库存价值为负，说明扣减过多，直接将库存价值清零
                // 这种情况理论上只会在浮点数精度问题时发生，Decimal库可避免，但作为最后防线
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
                // 正常更新库存数量和价值
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

            // 返回最新的原料信息
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
                        // [核心修复] TS2353: 将 doughIngredients 重命名为 componentIngredients
                        componentIngredients: true,
                        productIngredients: true,
                    },
                },
            },
        });

        if (!ingredientToDelete) {
            throw new NotFoundException('原料不存在或已被删除');
        }

        // [核心修复] TS2339 & TS2370: 使用正确的属性名 componentIngredients
        const usageCount =
            ingredientToDelete._count.componentIngredients + ingredientToDelete._count.productIngredients;

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

    // [核心重构] 重构库存流水查询逻辑以支持多维度筛选
    async getIngredientLedger(tenantId: string, ingredientId: string, query: QueryLedgerDto) {
        await this.findOne(tenantId, ingredientId); // 验证原料存在性
        const { page = 1, limit = 10, type, userId, startDate, endDate, keyword } = query;
        const pageNum = Number(page);
        const limitNum = Number(limit);
        const skip = (pageNum - 1) * limitNum;

        // 构建日期过滤条件
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

        // [核心修复] 为流水账数组指定明确的类型，以解决 Eslint 错误
        const ledger: LedgerEntry[] = [];

        // 1. 查询采购记录 (Procurement)
        if (!type || type === LedgerEntryType.PROCUREMENT) {
            const procurements = await this.prisma.procurementRecord.findMany({
                where: {
                    sku: { ingredientId: ingredientId },
                    ...(userId && { userId: userId }), // 按人员筛选
                    ...(hasDateFilter && { purchaseDate: dateFilter }), // 按日期筛选
                    ...(keyword && {
                        // 按关键字筛选
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
                // [核心修复] TS2363: 使用 Decimal.js 的 .mul() 方法进行高精度乘法，并用 .toNumber() 转换为数字
                change: new Prisma.Decimal(p.packagesPurchased).mul(p.sku.specWeightInGrams).toNumber(),
                details: `采购 ${p.sku.brand || ''} ${p.sku.specName} × ${p.packagesPurchased}`,
                operator: p.user.name || p.user.phone,
            }));
            ledger.push(...procurementLedger);
        }

        // 2. 查询生产消耗 (Consumption)
        if ((!type || type === LedgerEntryType.CONSUMPTION) && !userId) {
            // 生产消耗是系统行为，不按人员筛选
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
                // [核心修复] 将 Decimal 转换为 number
                change: -c.quantityInGrams.toNumber(),
                details: `生产任务 #${c.productionLog.task.id.slice(0, 8)}`,
                operator: '系统',
            }));
            ledger.push(...consumptionLedger);
        }

        // 3. 查询库存调整和生产损耗 (Adjustment & Spoilage)
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
                // [核心修复] TS2345: 将 change 属性从 Decimal 转换为 number
                change: a.changeInGrams.toNumber(),
                details: a.reason || '无原因',
                operator: a.user.name || a.user.phone,
            }));

            // 如果前端通过 type 筛选了 "库存调整" 或 "生产损耗"，则在内存中进一步过滤
            if (type === LedgerEntryType.ADJUSTMENT) {
                adjustmentLedger = adjustmentLedger.filter((a) => a.type === '库存调整');
            }
            if (type === LedgerEntryType.SPOILAGE) {
                adjustmentLedger = adjustmentLedger.filter((a) => a.type === '生产损耗');
            }

            // [核心修复] TS2345: adjustmentLedger 的 change 属性已在上一步修复，这里可以安全合并
            ledger.push(...adjustmentLedger);
        }

        // 统一排序、分页
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

            const procurement = await tx.procurementRecord.create({
                data: {
                    skuId,
                    packagesPurchased: createProcurementDto.packagesPurchased,
                    pricePerPackage: createProcurementDto.pricePerPackage,
                    // [核心修复] 恢复服务器端生成日期的逻辑
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
                    pricePerPackage: updateProcurementDto.pricePerPackage,
                },
            });
        });
    }
}
