/**
 * 文件路径: src/costing/costing.service.ts
 * 文件描述: 实现了配方成本计算的核心业务逻辑。
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

// [核心修复] 为采购记录添加 purchaseDate 字段
type ProcurementRecordWithDate = {
  pricePerPackage: Prisma.Decimal;
  purchaseDate: Date;
};

// [核心修复] 为原料类型定义添加更完整的采购记录类型
type IngredientWithPrice = {
  id: string;
  name: string;
  defaultSkuId: string | null;
  skus: {
    id: string;
    specWeightInGrams: number;
    procurementRecords: ProcurementRecordWithDate[];
  }[];
};

// [核心修复] 为用于成本计算的产品配方定义一个精确的类型
type ProductRecipeForCosting = {
  weight: number;
  recipeFamily: {
    doughs: {
      ingredients: {
        ratio: number;
        isFlour: boolean;
        ingredient: { id: string };
      }[];
    }[];
  };
  mixIns: {
    ratio: number;
    ingredient: { id: string };
  }[];
  addOns: {
    weight: number;
    extra: {
      ingredients: {
        ratio: number;
        ingredient: { id: string };
      }[];
    };
  }[];
};

@Injectable()
export class CostingService {
  constructor(private prisma: PrismaService) {}

  /**
   * 计算单个原料品类的成本 (元/克)
   * @param ingredient 包含SKU和采购记录的原料对象
   */
  private getIngredientCostPerGram(ingredient: IngredientWithPrice): number {
    // 优先使用默认SKU
    const targetSku =
      ingredient.skus.find((s) => s.id === ingredient.defaultSkuId) ||
      ingredient.skus[0];

    if (!targetSku || targetSku.procurementRecords.length === 0) {
      return 0; // 如果没有SKU或采购记录，成本为0
    }

    // 使用最新的采购价格作为成本基准
    // [核心修复] procurementRecords 现在有正确的类型，可以安全地排序
    const latestProcurement = targetSku.procurementRecords.sort(
      (a, b) => b.purchaseDate.getTime() - a.purchaseDate.getTime(),
    )[0];

    if (!latestProcurement) return 0;

    const pricePerPackage = new Prisma.Decimal(
      latestProcurement.pricePerPackage,
    );
    const weightInGrams = new Prisma.Decimal(targetSku.specWeightInGrams);

    if (weightInGrams.isZero()) return 0;

    return pricePerPackage.div(weightInGrams).toNumber();
  }

  /**
   * 计算单个产品的总成本
   * @param productRecipe 产品的完整配方数据
   */
  async calculateProductCost(
    productRecipe: ProductRecipeForCosting,
  ): Promise<number> {
    // 1. 获取所有涉及的原料ID
    const ingredientIds = new Set<string>();
    // [核心修复] 由于 productRecipe 现在是强类型，所有访问都是类型安全的
    productRecipe.recipeFamily.doughs.forEach((d) =>
      d.ingredients.forEach((i) => ingredientIds.add(i.ingredient.id)),
    );
    productRecipe.mixIns.forEach((m) => ingredientIds.add(m.ingredient.id));
    productRecipe.addOns.forEach((a) =>
      a.extra.ingredients.forEach((i) => ingredientIds.add(i.ingredient.id)),
    );

    // 2. 一次性查询所有相关原料的成本信息
    const ingredientsWithCostData = await this.prisma.ingredient.findMany({
      where: { id: { in: Array.from(ingredientIds) } },
      include: {
        skus: {
          include: {
            procurementRecords: {
              orderBy: { purchaseDate: 'desc' },
            },
          },
        },
      },
    });

    const ingredientCostMap = new Map<string, number>();
    ingredientsWithCostData.forEach((ing) => {
      ingredientCostMap.set(
        ing.id,
        this.getIngredientCostPerGram(ing as IngredientWithPrice),
      );
    });

    // 3. 计算总成本
    let totalCost = 0;

    // 3a. 计算总面粉重量
    let totalFlourRatio = 0;
    productRecipe.recipeFamily.doughs.forEach((d) => {
      d.ingredients.forEach((i) => {
        if (i.isFlour) totalFlourRatio += i.ratio;
      });
    });
    if (totalFlourRatio === 0) return 0; // 避免除以0

    let totalRatio = 0;
    productRecipe.recipeFamily.doughs.forEach((d) =>
      d.ingredients.forEach((i) => (totalRatio += i.ratio)),
    );
    productRecipe.mixIns.forEach((m) => (totalRatio += m.ratio));
    if (totalRatio === 0) return 0;

    const singleProductTotalFlourWeight =
      (productRecipe.weight / totalRatio) * totalFlourRatio;

    // 3b. 累加面团和混入料的成本
    const accumulateCost = (
      items: { ratio: number; ingredient: { id: string } }[],
    ) => {
      items.forEach((item) => {
        const weight =
          (item.ratio / totalFlourRatio) * singleProductTotalFlourWeight;
        const costPerGram = ingredientCostMap.get(item.ingredient.id) || 0;
        totalCost += weight * costPerGram;
      });
    };
    productRecipe.recipeFamily.doughs.forEach((d) =>
      accumulateCost(d.ingredients),
    );
    accumulateCost(productRecipe.mixIns);

    // 3c. 累加附加项的成本
    productRecipe.addOns.forEach((addOn) => {
      const extraRecipe = addOn.extra;
      const totalExtraRatio = extraRecipe.ingredients.reduce(
        (sum, ing) => sum + ing.ratio,
        0,
      );
      if (totalExtraRatio > 0) {
        extraRecipe.ingredients.forEach((ing) => {
          const weight = (ing.ratio / totalExtraRatio) * addOn.weight;
          const costPerGram = ingredientCostMap.get(ing.ingredient.id) || 0;
          totalCost += weight * costPerGram;
        });
      }
    });

    return totalCost;
  }
}
