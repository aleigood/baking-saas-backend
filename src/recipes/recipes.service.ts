/**
 * 文件路径: src/recipes/recipes.service.ts
 * 文件描述: (已修正) 实现了完整的配方创建和查询逻辑，并修复了静态检查错误。
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateRecipeFamilyDto } from './dto/create-recipe.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
// [核心修复] 移除了未使用的 'Prisma' 类型导入，解决 no-unused-vars 警告。

@Injectable()
export class RecipesService {
  constructor(private prisma: PrismaService) {}

  /**
   * [核心更新] 创建一个完整的配方家族及其所有关联项。
   * 使用 Prisma 事务来确保数据一致性。
   * @param createRecipeFamilyDto 包含完整配方信息的 DTO
   * @param user 当前用户信息
   */
  async create(
    createRecipeFamilyDto: CreateRecipeFamilyDto,
    user: UserPayload,
  ) {
    const { name, doughs, products, procedures } = createRecipeFamilyDto;
    const { tenantId } = user;

    return this.prisma.$transaction(async (tx) => {
      // 1. 创建配方家族 (RecipeFamily)
      const recipeFamily = await tx.recipeFamily.create({
        data: {
          name,
          tenantId,
        },
      });

      // 2. 处理并创建所有面团 (Doughs) 及其原料
      for (const doughDto of doughs) {
        await tx.dough.create({
          data: {
            name: doughDto.name,
            isPreDough: doughDto.isPreDough,
            targetTemp: doughDto.targetTemp,
            recipeFamilyId: recipeFamily.id,
            ingredients: {
              create: doughDto.ingredients.map((ing) => ({
                ratio: ing.ratio,
                isFlour: ing.isFlour,
                ingredient: {
                  connectOrCreate: {
                    where: { tenantId_name: { tenantId, name: ing.name } },
                    create: { name: ing.name, tenantId },
                  },
                },
              })),
            },
          },
        });
      }

      // 3. 处理并创建所有最终产品 (Products) 及其关联项
      for (const productDto of products) {
        await tx.product.create({
          data: {
            name: productDto.name,
            weight: productDto.weight,
            recipeFamilyId: recipeFamily.id,
            // 3a. 关联混入的原料 (MixIns)
            mixIns: {
              create: productDto.mixIns.map((mixIn) => ({
                ratio: mixIn.ratio,
                ingredient: {
                  connectOrCreate: {
                    where: { tenantId_name: { tenantId, name: mixIn.name } },
                    create: { name: mixIn.name, tenantId },
                  },
                },
              })),
            },
            // 3b. 关联附加项/子配方 (AddOns)
            addOns: {
              create: productDto.addOns.map((addOn) => ({
                weight: addOn.weight,
                type: addOn.type,
                extra: {
                  connectOrCreate: {
                    // [核心修复] 使用修正后的 schema，这里的 where 条件现在是有效的
                    where: { tenantId_name: { tenantId, name: addOn.name } },
                    // 注意：如果附加项不存在，这里仅创建名称，其具体配方需另外管理
                    create: { name: addOn.name, tenantId },
                  },
                },
              })),
            },
            // 3c. 关联特定于此产品的工序
            procedures: {
              create: productDto.procedures.map((proc) => ({
                step: proc.step,
                name: proc.name,
                description: proc.description,
              })),
            },
          },
        });
      }

      // 4. 创建通用于整个配方家族的工序
      if (procedures && procedures.length > 0) {
        await tx.procedure.createMany({
          data: procedures.map((proc) => ({
            ...proc,
            recipeFamilyId: recipeFamily.id,
          })),
        });
      }

      return recipeFamily;
    });
  }

  /**
   * [核心更新] 获取当前店铺的所有最终产品列表，用于在小程序中展示。
   * 返回的数据结构已根据前端需求进行格式化。
   * @param user 当前用户信息
   */
  async findAll(user: UserPayload) {
    const products = await this.prisma.product.findMany({
      where: { recipeFamily: { tenantId: user.tenantId } },
      include: {
        recipeFamily: true,
        _count: {
          select: { tasks: true }, // 附加查询：统计该产品的生产任务总数
        },
      },
    });

    // 映射数据以匹配前端期望的格式 (src/types/api.d.ts)
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.recipeFamily.name,
      weight: p.weight,
      rating: 4.8, // 模拟数据
      publicCount: p._count.tasks, // 使用真实的生产次数
      ingredients: [], // 注意：列表页通常不展示详细原料以优化性能
    }));
  }

  /**
   * [核心更新] 获取单个最终产品的完整详情。
   * @param id 产品ID
   * @param user 当前用户信息
   */
  async findOne(id: string, user: UserPayload) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        recipeFamily: {
          tenantId: user.tenantId, // 确保只能查询到自己店铺的产品
        },
      },
      include: {
        // 包含所有关联的详细信息
        recipeFamily: {
          include: {
            doughs: {
              include: {
                ingredients: {
                  include: {
                    ingredient: true,
                  },
                },
              },
            },
            procedures: true, // 配方家族的通用工序
          },
        },
        mixIns: {
          include: {
            ingredient: true,
          },
        },
        addOns: {
          include: {
            extra: true,
          },
        },
        procedures: true, // 产品的特定工序
      },
    });

    if (!product) {
      throw new NotFoundException(`ID为 ${id} 的产品不存在或无权访问`);
    }

    // 这里可以根据需要进一步处理和格式化返回的数据结构
    return product;
  }
}
