/**
 * 文件路径: src/ingredients/ingredients.service.ts
 * 文件描述: (功能完善) 新增了更新原料信息和设置默认SKU的逻辑。
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { Prisma } from '@prisma/client';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';

@Injectable()
export class IngredientsService {
  constructor(private prisma: PrismaService) {}

  create(createIngredientDto: CreateIngredientDto, tenantId: string) {
    return this.prisma.ingredient.create({
      data: {
        ...createIngredientDto,
        tenantId,
      },
    });
  }

  /**
   * 获取指定店铺的原料列表，并计算真实库存和成本。
   * @param tenantId 店铺ID
   */
  async findAllForTenant(tenantId: string) {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId },
      include: {
        skus: {
          include: {
            procurementRecords: true,
          },
        },
        consumptionRecords: true,
      },
    });

    return ingredients.map((ingredient) => {
      let totalGramsPurchased = 0;
      let totalCost = new Prisma.Decimal(0);

      for (const sku of ingredient.skus) {
        for (const record of sku.procurementRecords) {
          totalGramsPurchased +=
            record.packagesPurchased * sku.specWeightInGrams;
          totalCost = totalCost.add(
            new Prisma.Decimal(record.packagesPurchased).mul(
              record.pricePerPackage,
            ),
          );
        }
      }

      const totalGramsConsumed = ingredient.consumptionRecords.reduce(
        (sum, record) => sum + record.amountConsumedInGrams,
        0,
      );

      const stockInKg = (totalGramsPurchased - totalGramsConsumed) / 1000;

      const pricePerKg =
        totalGramsPurchased > 0
          ? totalCost.mul(1000).div(totalGramsPurchased).toDP(2).toNumber()
          : 0;

      return {
        id: ingredient.id,
        name: ingredient.name,
        brand:
          ingredient.skus.find((s) => s.id === ingredient.defaultSkuId)
            ?.brand ||
          ingredient.skus[0]?.brand ||
          'N/A',
        price: pricePerKg,
        stock: Math.max(0, stockInKg),
      };
    });
  }

  createSku(ingredientId: string, createSkuDto: CreateSkuDto) {
    return this.prisma.ingredientSKU.create({
      data: {
        ingredientId,
        ...createSkuDto,
        specWeightInGrams: createSkuDto.specWeightInGrams,
      },
    });
  }

  createProcurement(createProcurementDto: CreateProcurementDto) {
    const { skuId, ...restData } = createProcurementDto;
    return this.prisma.procurementRecord.create({
      data: {
        ...restData,
        pricePerPackage: new Prisma.Decimal(restData.pricePerPackage),
        sku: {
          connect: {
            id: skuId,
          },
        },
      },
    });
  }

  /**
   * [新增] 更新原料信息，例如含水率
   * @param ingredientId 原料ID
   * @param updateIngredientDto 包含更新数据的DTO
   * @param user 当前用户信息
   */
  async update(
    ingredientId: string,
    updateIngredientDto: UpdateIngredientDto,
    user: UserPayload,
  ) {
    const ingredient = await this.prisma.ingredient.findFirst({
      where: { id: ingredientId, tenantId: user.tenantId },
    });

    if (!ingredient) {
      throw new NotFoundException('原料不存在或无权操作');
    }

    return this.prisma.ingredient.update({
      where: { id: ingredientId },
      data: updateIngredientDto,
    });
  }

  /**
   * [新增] 为原料设置默认SKU
   * @param ingredientId 原料ID
   * @param skuId 要设置为默认的SKU ID
   * @param user 当前用户信息
   */
  async setDefaultSku(ingredientId: string, skuId: string, user: UserPayload) {
    return this.prisma.$transaction(async (tx) => {
      const ingredient = await tx.ingredient.findFirst({
        where: { id: ingredientId, tenantId: user.tenantId },
      });

      if (!ingredient) {
        throw new NotFoundException('原料不存在或无权操作');
      }

      const sku = await tx.ingredientSKU.findFirst({
        where: { id: skuId, ingredientId: ingredientId },
      });

      if (!sku) {
        throw new NotFoundException('SKU不存在或不属于该原料');
      }

      return tx.ingredient.update({
        where: { id: ingredientId },
        data: { defaultSkuId: skuId },
      });
    });
  }
}
