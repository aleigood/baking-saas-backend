import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Tenant } from '@prisma/client';
import {
  ProductionTaskDto,
  RecipeDto,
  IngredientDto,
  MemberDto,
  RecipeStatDto,
  IngredientStatDto,
} from './dto/tenant-data.dto';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  async findForUser(user: UserPayload): Promise<Tenant[]> {
    return this.prisma.tenant.findMany({
      where: {
        users: {
          some: {
            userId: user.userId,
          },
        },
      },
    });
  }

  async findProductionTasks(tenantId: string): Promise<ProductionTaskDto[]> {
    const tasks = await this.prisma.productionTask.findMany({
      where: { tenantId },
      include: { product: true, creator: true },
      orderBy: { createdAt: 'desc' },
    });

    return tasks.map((task) => ({
      id: task.id,
      recipeName: task.product.name,
      time: task.createdAt.toISOString(),
      creator: task.creator.name,
      status: task.status,
    }));
  }

  async findRecipes(tenantId: string): Promise<RecipeDto[]> {
    const products = await this.prisma.product.findMany({
      where: { recipeFamily: { tenantId } },
      include: { recipeFamily: true },
    });

    return products.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.recipeFamily.name,
      weight: p.weight,
      rating: 4.8,
      publicCount: 100,
      ingredients: [],
    }));
  }

  async findIngredients(tenantId: string): Promise<IngredientDto[]> {
    const ingredients = await this.prisma.ingredient.findMany({
      where: { tenantId },
      include: { skus: true },
    });

    return ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      brand: i.skus[0]?.brand || 'N/A',
      price: 10.0,
      stock: 100,
    }));
  }

  async findMembers(tenantId: string): Promise<MemberDto[]> {
    const tenantUsers = await this.prisma.tenantUser.findMany({
      where: { tenantId, status: 'ACTIVE' },
      include: { user: true },
    });

    return tenantUsers.map((tu) => ({
      id: tu.user.id,
      name: tu.user.name,
      role: tu.role,
      joinDate: tu.createdAt.toISOString().split('T')[0],
    }));
  }

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
