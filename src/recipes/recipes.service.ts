/**
 * 文件路径: src/recipes/recipes.service.ts
 * 文件描述: 处理所有与配方相关的数据库操作和业务逻辑。
 */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common'; // 1. 导入ForbiddenException
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
   * (此方法保持不变)
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
   * (此方法保持不变)
   */
  async findAll(user: UserPayload) {
    return this.prisma.recipeFamily.findMany({
      where: {
        tenantId: user.tenantId,
      },
    });
  }

  /**
   * --- 新增方法 ---
   * 查找单个配方家族的完整详情
   * @param id - 要查找的配方家族ID
   * @param user - 从JWT令牌中解析出的当前用户信息
   * @returns 包含所有关联数据的配方家族对象
   */
  async findOne(id: string, user: UserPayload) {
    // 1. 根据ID查找配方
    const recipeFamily = await this.prisma.recipeFamily.findUnique({
      where: { id },
      // 2. 使用 include 加载所有关联的详细数据
      include: {
        procedures: true, // 通用工序
        doughs: {
          include: {
            ingredients: {
              include: {
                ingredient: true, // 加载原料详情
              },
            },
          },
        },
        products: {
          include: {
            procedures: true, // 产品特定工序
            mixIns: {
              include: {
                ingredient: true,
              },
            },
            addOns: {
              include: {
                extra: true, // 加载附加项详情
              },
            },
          },
        },
      },
    });

    // 3. 如果找不到配方，抛出404错误
    if (!recipeFamily) {
      throw new NotFoundException(`ID为 ${id} 的配方不存在`);
    }

    // 4. 安全检查：确保该配方属于当前登录用户所在的门店
    if (recipeFamily.tenantId !== user.tenantId) {
      throw new ForbiddenException('您无权访问此配方');
    }

    return recipeFamily;
  }
}
