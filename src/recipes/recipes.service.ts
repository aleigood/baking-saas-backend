/**
 * 文件路径: src/recipes/recipes.service.ts
 * 文件描述: 处理所有与配方相关的数据库操作和业务逻辑。
 */
// 修复点：移除了未使用的 'NotFoundException' 导入
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateRecipeFamilyDto } from './dto/create-recipe.dto';

@Injectable()
export class RecipesService {
  /**
   * 构造函数，注入Prisma服务以便操作数据库。
   */
  constructor(private prisma: PrismaService) {}

  /**
   * 创建一个新的配方家族
   * @param createRecipeFamilyDto - 包含完整配方信息的DTO
   * @param user - 从JWT令牌中解析出的当前用户信息
   * @returns 创建成功的配方家族对象
   */
  async create(
    createRecipeFamilyDto: CreateRecipeFamilyDto,
    user: UserPayload,
  ) {
    const { name, doughs, products, procedures } = createRecipeFamilyDto;
    const { tenantId } = user;

    // 使用事务确保所有相关的表都能被原子性地创建
    return this.prisma.$transaction(async (tx) => {
      // 1. 创建配方家族主体
      const recipeFamily = await tx.recipeFamily.create({
        data: {
          name,
          tenantId,
          // 创建通用的工序
          procedures: {
            create: procedures.map((p) => ({
              step: p.step,
              name: p.name,
              description: p.description,
            })),
          },
        },
      });

      // 2. 遍历并创建所有面团及其原料
      for (const doughDto of doughs) {
        await tx.dough.create({
          data: {
            name: doughDto.name,
            isPreDough: doughDto.isPreDough,
            targetTemp: doughDto.targetTemp,
            recipeFamilyId: recipeFamily.id,
            // 创建面团中的原料关联
            ingredients: {
              create: await Promise.all(
                doughDto.ingredients.map(async (ing) => {
                  // 查找或创建原料
                  const ingredient = await tx.ingredient.upsert({
                    where: { tenantId_name: { tenantId, name: ing.name } },
                    update: {},
                    create: { name: ing.name, tenantId },
                  });
                  return {
                    ingredientId: ingredient.id,
                    ratio: ing.ratio,
                    isFlour: ing.isFlour,
                  };
                }),
              ),
            },
          },
        });
      }

      // 3. 遍历并创建所有最终产品及其关联项
      for (const productDto of products) {
        await tx.product.create({
          data: {
            name: productDto.name,
            weight: productDto.weight,
            recipeFamilyId: recipeFamily.id,
            // 创建产品特定的工序
            procedures: {
              create: productDto.procedures.map((p) => ({
                step: p.step,
                name: p.name,
                description: p.description,
              })),
            },
            // 创建混入面团的原料
            mixIns: {
              create: await Promise.all(
                productDto.mixIns.map(async (mixIn) => {
                  const ingredient = await tx.ingredient.upsert({
                    where: { tenantId_name: { tenantId, name: mixIn.name } },
                    update: {},
                    create: { name: mixIn.name, tenantId },
                  });
                  return { ingredientId: ingredient.id, ratio: mixIn.ratio };
                }),
              ),
            },
            // 创建附加项（馅料/装饰）
            addOns: {
              create: await Promise.all(
                productDto.addOns.map(async (addOn) => {
                  // --- 修复点：解决 'Extra' 的 upsert 类型错误 ---
                  // 原因：`upsert` 的 `where` 条件必须是一个唯一字段，而我们当前的
                  // `Extra` 模型中 `name` 字段不是唯一的。
                  // 解决方案：我们手动实现 "find-or-create" 逻辑，这与upsert效果相同，
                  // 且能与我们当前的数据库模型完美配合。

                  // 1. 尝试根据名称和租户ID查找已存在的Extra
                  let extra = await tx.extra.findFirst({
                    where: { name: addOn.name, tenantId: tenantId },
                  });

                  // 2. 如果不存在，则创建一个新的
                  if (!extra) {
                    extra = await tx.extra.create({
                      data: { name: addOn.name, tenantId: tenantId },
                    });
                  }

                  // 3. 返回关联所需的数据
                  return {
                    extraId: extra.id,
                    weight: addOn.weight,
                    type: addOn.type,
                  };
                }),
              ),
            },
          },
        });
      }

      return recipeFamily;
    });
  }

  /**
   * 查找当前租户的所有配方家族
   * @param user - 从JWT令牌中解析出的当前用户信息
   * @returns 配方家族列表
   */
  async findAll(user: UserPayload) {
    return this.prisma.recipeFamily.findMany({
      where: {
        tenantId: user.tenantId,
      },
      // 可以通过 include 加载关联数据，但为了性能，列表接口通常不加载所有详情
      // include: { doughs: true, products: true }
    });
  }
}
