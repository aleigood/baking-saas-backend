import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SkuStatus } from '@prisma/client';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { UpdateStockDto } from './dto/update-stock.dto';
import { Prisma } from '@prisma/client';

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
        await this.findOne(tenantId, id);
        return this.prisma.ingredient.update({
            where: { id },
            data: updateIngredientDto,
        });
    }

    async updateStock(tenantId: string, id: string, updateStockDto: UpdateStockDto) {
        await this.findOne(tenantId, id);
        return this.prisma.ingredient.update({
            where: { id },
            data: {
                currentStockInGrams: updateStockDto.currentStockInGrams,
            },
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

        // 2. [核心修改] 使用反向关联的_count来检查原料是否被使用
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

    // 为原料创建新的SKU
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

    async deleteSku(tenantId: string, skuId: string) {
        const skuToDelete = await this.prisma.ingredientSKU.findFirst({
            where: {
                id: skuId,
                ingredient: {
                    tenantId: tenantId,
                },
            },
            include: {
                ingredient: {
                    include: {
                        _count: {
                            select: {
                                doughIngredients: true,
                                productIngredients: true,
                            },
                        },
                    },
                },
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

        // 3. [核心修改] 使用反向关联的_count来检查原料是否被使用
        const isIngredientInUse =
            skuToDelete.ingredient._count.doughIngredients > 0 || skuToDelete.ingredient._count.productIngredients > 0;

        const hasProcurementRecords = skuToDelete._count.procurementRecords > 0;

        if (isIngredientInUse && hasProcurementRecords) {
            throw new BadRequestException('该SKU所属原料已被配方使用，且该SKU存在采购记录，无法删除。');
        }

        return this.prisma.$transaction(async (tx) => {
            if (hasProcurementRecords) {
                await tx.procurementRecord.deleteMany({
                    where: { skuId: skuId },
                });
            }
            return tx.ingredientSKU.delete({
                where: { id: skuId },
            });
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

    async updateProcurement(tenantId: string, procurementId: string, updateProcurementDto: UpdateProcurementDto) {
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

        return this.prisma.procurementRecord.update({
            where: { id: procurementId },
            data: {
                pricePerPackage: updateProcurementDto.pricePerPackage,
            },
        });
    }
}
