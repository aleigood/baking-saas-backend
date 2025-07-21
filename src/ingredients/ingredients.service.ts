/**
 * 文件路径: src/ingredients/ingredients.service.ts
 * 文件描述: (功能完善) 实现了真实的库存和成本计算逻辑。
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { Prisma } from '@prisma/client';

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
   * [核心更新] 获取指定店铺的原料列表，并计算真实库存和成本。
   * @param tenantId 店铺ID
   */
  async findAllForTenant(tenantId: string) {
    // 1. 获取店铺下的所有原料及其SKU
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId },
      include: {
        skus: {
          include: {
            procurementRecords: true, // 获取所有采购记录用于计算
          },
        },
        consumptionRecords: true, // 获取所有消耗记录
      },
    });

    // 2. 映射并计算每个原料的数据
    return ingredients.map((ingredient) => {
      let totalGramsPurchased = 0;
      let totalCost = new Prisma.Decimal(0);

      // 2a. 计算总采购量和总成本
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

      // 2b. 计算总消耗量
      const totalGramsConsumed = ingredient.consumptionRecords.reduce(
        (sum, record) => sum + record.amountConsumedInGrams,
        0,
      );

      // 2c. 计算实时库存 (kg)
      const stockInKg = (totalGramsPurchased - totalGramsConsumed) / 1000;

      // 2d. 计算加权平均成本 (元/kg)
      const pricePerKg =
        totalGramsPurchased > 0
          ? totalCost
              .mul(1000)
              .div(totalGramsPurchased)
              .toDP(2) // 保留两位小数
              .toNumber()
          : 0;

      return {
        id: ingredient.id,
        name: ingredient.name,
        // 优先使用默认SKU的品牌，否则使用第一个SKU的品牌
        brand:
          ingredient.skus.find((s) => s.id === ingredient.defaultSkuId)
            ?.brand ||
          ingredient.skus[0]?.brand ||
          'N/A',
        price: pricePerKg,
        stock: Math.max(0, stockInKg), // 库存不能为负
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
}
