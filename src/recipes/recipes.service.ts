import { Injectable } from '@nestjs/common';
import { CreateRecipeFamilyDto } from './dto/create-recipe.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@Injectable()
export class RecipesService {
  constructor(private prisma: PrismaService) {}

  create(createRecipeFamilyDto: CreateRecipeFamilyDto, user: UserPayload) {
    return this.prisma.recipeFamily.create({
      data: {
        name: createRecipeFamilyDto.name,
        tenantId: user.tenantId,
      },
    });
  }

  async findAll(user: UserPayload) {
    const products = await this.prisma.product.findMany({
      where: { recipeFamily: { tenantId: user.tenantId } },
      include: { recipeFamily: true },
    });

    // 映射数据以匹配前端期望的格式
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.recipeFamily.name,
      weight: p.weight,
      rating: 4.8, // 注意：此为模拟数据，您的 schema 中没有评级字段
      publicCount: 100, // 注意：此为模拟数据
      ingredients: [], // 注意：此为模拟数据，需要单独的查询来构建
    }));
  }

  findOne(id: string, user: UserPayload) {
    return `This action returns a #${id} recipe for user ${user.userId}`;
  }
}
