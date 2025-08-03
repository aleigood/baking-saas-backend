import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';

// 修复：导出CostDetail接口，以便其他文件可以导入
export interface CostDetail {
  ingredientName: string;
  consumedGrams: number | string;
  costPerGram: number | string;
  totalCost: number | string;
  note?: string;
}

@Injectable()
export class CostingService {
  constructor(private prisma: PrismaService) {}

  /**
   * 分析单个产品的理论成本
   * @param tenantId 租户ID
   * @param productId 产品ID
   * @returns 成本分析报告
   */
  async analyzeProductCost(tenantId: string, productId: string) {
    // 1. 获取产品及其当前激活的配方版本
    const product = await this.prisma.product.findFirst({
      where: {
        id: productId,
        recipeVersion: {
          isActive: true,
          family: {
            tenantId,
          },
        },
      },
      include: {
        recipeVersion: {
          include: {
            doughs: {
              include: {
                ingredients: true,
              },
            },
          },
        },
      },
    });

    if (!product || !product.recipeVersion) {
      throw new NotFoundException(
        `ID为 ${productId} 的产品或其激活的配方未找到。`,
      );
    }

    const mainDough = product.recipeVersion.doughs[0];
    if (!mainDough) {
      throw new NotFoundException('配方数据不完整，缺少面团定义。');
    }

    // 2. 计算生产一个单位产品所需的总面粉量
    const totalFlourRatio = mainDough.ingredients
      .filter((ing) => ing.isFlour)
      .reduce((sum, ing) => sum + ing.ratio, 0);

    if (totalFlourRatio === 0) {
      throw new NotFoundException('配方中未定义面粉，无法计算成本。');
    }
    // 单个产品的总面团重量 / 面粉在总配料中的占比 = 单个产品所需的总面粉克数
    const totalFlourWeightPerUnit =
      (product.baseDoughWeight / totalFlourRatio) * 100;

    // 3. 遍历所有原料，计算其成本
    const costDetails: CostDetail[] = []; // 明确指定数组类型
    let totalCost = new Decimal(0);

    for (const ingredient of mainDough.ingredients) {
      const ingredientRecord = await this.prisma.ingredient.findFirst({
        where: { name: ingredient.name, tenantId },
        include: { defaultSku: true },
      });

      if (!ingredientRecord || !ingredientRecord.defaultSkuId) {
        // 如果原料或其默认SKU未设置，则成本计为0
        costDetails.push({
          ingredientName: ingredient.name,
          consumedGrams: 0,
          costPerGram: 0,
          totalCost: 0,
          note: '原料未在系统中定义或未设置默认SKU',
        });
        continue;
      }

      // 获取最新一次的采购记录以确定价格
      const latestProcurement = await this.prisma.procurementRecord.findFirst({
        where: { skuId: ingredientRecord.defaultSkuId },
        orderBy: { purchaseDate: 'desc' },
      });

      if (!latestProcurement) {
        // 如果没有采购记录，成本也计为0
        costDetails.push({
          ingredientName: ingredient.name,
          consumedGrams: 0,
          costPerGram: 0,
          totalCost: 0,
          note: '缺少采购记录，无法确定价格',
        });
        continue;
      }

      const sku = ingredientRecord.defaultSku;
      if (!sku) {
        // 理论上不会发生，因为我们已经检查了defaultSkuId
        continue;
      }

      // 计算每克成本
      const pricePerGram = latestProcurement.pricePerPackage.dividedBy(
        sku.specWeightInGrams,
      );

      // 计算该原料的消耗量（克）
      const consumedGrams = (ingredient.ratio / 100) * totalFlourWeightPerUnit;

      // 计算该原料的总成本
      const ingredientTotalCost = pricePerGram.times(consumedGrams);
      totalCost = totalCost.plus(ingredientTotalCost);

      costDetails.push({
        ingredientName: ingredient.name,
        consumedGrams: consumedGrams.toFixed(2),
        costPerGram: pricePerGram.toFixed(4),
        totalCost: ingredientTotalCost.toFixed(4),
      });
    }

    return {
      productName: product.name,
      recipeVersion: product.recipeVersion.version,
      totalCost: totalCost.toFixed(4),
      costDetails,
    };
  }
}
