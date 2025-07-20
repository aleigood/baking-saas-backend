import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RecipeStatDto, IngredientStatDto } from './dto/stats.dto';

@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService) {}

  async findRecipeStats(tenantId: string): Promise<RecipeStatDto[]> {
    const stats = await this.prisma.productionTask.groupBy({
      by: ['productId'],
      where: { tenantId, status: 'COMPLETED' },
      _count: {
        productId: true,
      },
      orderBy: {
        _count: {
          productId: 'desc',
        },
      },
    });

    if (stats.length === 0) return [];

    const productIds = stats.map((s) => s.productId);
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
      },
      select: {
        id: true,
        name: true,
      },
    });

    const productMap = new Map(products.map((p) => [p.id, p.name]));

    return stats.map((s) => ({
      name: productMap.get(s.productId) || '未知产品',
      count: s._count.productId,
    }));
  }

  async findIngredientStats(tenantId: string): Promise<IngredientStatDto[]> {
    const stats = await this.prisma.consumptionRecord.groupBy({
      by: ['ingredientId'],
      where: {
        task: {
          tenantId: tenantId,
        },
      },
      _sum: {
        amountConsumedInGrams: true,
      },
      orderBy: {
        _sum: {
          amountConsumedInGrams: 'desc',
        },
      },
    });

    if (stats.length === 0) return [];

    const ingredientIds = stats.map((s) => s.ingredientId);
    const ingredients = await this.prisma.ingredient.findMany({
      where: { id: { in: ingredientIds } },
      select: { id: true, name: true },
    });

    const ingredientMap = new Map(ingredients.map((i) => [i.id, i.name]));

    return stats.map((s) => ({
      name: ingredientMap.get(s.ingredientId) || '未知原料',
      consumed: (s._sum.amountConsumedInGrams || 0) / 1000, // 转换为 kg
    }));
  }
}
