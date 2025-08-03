import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SkuStatus } from '@prisma/client';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';

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

    // 查询租户下的所有原料
    async findAll(tenantId: string) {
        return this.prisma.ingredient.findMany({
            where: {
                tenantId,
                deletedAt: null,
            },
            include: {
                // V2.1 优化: 查询时总是包含激活的SKU信息
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

    // 软删除原料品类
    async remove(tenantId: string, id: string) {
        // 确保该原料存在且属于该租户
        await this.findOne(tenantId, id);
        return this.prisma.ingredient.update({
            where: { id },
            data: {
                deletedAt: new Date(),
            },
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
     * [V2.1 核心逻辑重写] 创建采购记录并更新库存
     * @param tenantId 租户ID
     * @param skuId SKU ID
     * @param createProcurementDto DTO
     */
    async createProcurement(tenantId: string, skuId: string, createProcurementDto: CreateProcurementDto) {
        // 1. 查找SKU，并确保它属于该租户
        const sku = await this.prisma.ingredientSKU.findFirst({
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

        // 2. V2.1 业务规则: 只有激活的SKU才能进行采购入库
        if (sku.status !== SkuStatus.ACTIVE) {
            throw new BadRequestException('只有激活状态的SKU才能进行采购入库');
        }

        const { packagesPurchased, pricePerPackage } = createProcurementDto;

        // 3. 计算本次入库的总克数
        const stockIncrease = packagesPurchased * sku.specWeightInGrams;

        // 4. 使用数据库事务来保证数据一致性
        return this.prisma.$transaction(async (tx) => {
            // 4.1 创建采购历史记录
            await tx.procurementRecord.create({
                data: {
                    skuId,
                    packagesPurchased,
                    pricePerPackage,
                },
            });

            // 4.2 更新SKU的实时库存和当前单价
            const updatedSku = await tx.ingredientSKU.update({
                where: { id: skuId },
                data: {
                    // 增加实时库存
                    currentStockInGrams: {
                        increment: stockIncrease,
                    },
                    // 更新为最新的采购单价
                    currentPricePerPackage: pricePerPackage,
                },
            });

            return updatedSku;
        });
    }
}
