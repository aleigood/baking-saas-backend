/**
 * 文件路径: src/recipes/recipes.service.ts
 * 文件描述: (完整最终版) 恢复了所有方法，解决了静态检查错误。
 */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { CreateRecipeFamilyDto } from './dto/create-recipe.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Role } from '@prisma/client';

@Injectable()
export class RecipesService {
  constructor(private prisma: PrismaService) {}

  /**
   * 创建一个配方家族及其首个版本。
   * @param createRecipeFamilyDto 包含完整配方信息的 DTO
   * @param user 当前用户信息
   */
  async create(
    createRecipeFamilyDto: CreateRecipeFamilyDto,
    user: UserPayload,
  ) {
    // 权限校验
    if (user.role === Role.BAKER) {
      throw new ForbiddenException('仅老板或主管可以创建配方。');
    }

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

      // 2. 创建首个配方版本 (RecipeVersion)
      const recipeVersion = await tx.recipeVersion.create({
        data: {
          recipeFamilyId: recipeFamily.id,
          versionNumber: 1,
          name: '初始版本',
          isActive: true,
        },
      });

      // 3. 处理并创建所有面团 (Doughs) 及其原料，关联到新版本
      for (const doughDto of doughs) {
        for (const ing of doughDto.ingredients) {
          await tx.ingredient.upsert({
            where: { tenantId_name: { tenantId, name: ing.name } },
            update: {},
            create: { name: ing.name, tenantId },
          });
        }

        await tx.dough.create({
          data: {
            name: doughDto.name,
            isPreDough: doughDto.isPreDough,
            targetTemp: doughDto.targetTemp,
            lossRatio: doughDto.lossRatio || 0,
            recipeVersionId: recipeVersion.id,
            ingredients: {
              create: doughDto.ingredients.map((ing) => ({
                ratio: ing.ratio,
                isFlour: ing.isFlour,
                ingredient: {
                  connect: {
                    tenantId_name: { tenantId, name: ing.name },
                  },
                },
              })),
            },
          },
        });
      }

      // 4. 处理并创建所有最终产品 (Products) 及其关联项，关联到新版本
      for (const productDto of products) {
        await tx.product.create({
          data: {
            name: productDto.name,
            weight: productDto.weight,
            recipeVersionId: recipeVersion.id,
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
            addOns: {
              create: productDto.addOns.map((addOn) => ({
                weight: addOn.weight,
                type: addOn.type,
                extra: {
                  connectOrCreate: {
                    where: { tenantId_name: { tenantId, name: addOn.name } },
                    create: { name: addOn.name, tenantId },
                  },
                },
              })),
            },
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

      // 5. 创建通用于整个配方版本的工序
      if (procedures && procedures.length > 0) {
        await tx.procedure.createMany({
          data: procedures.map((proc) => ({
            ...proc,
            recipeVersionId: recipeVersion.id,
          })),
        });
      }

      return recipeFamily;
    });
  }

  /**
   * 获取当前店铺所有最终产品列表，仅包含激活版本的产品。
   */
  async findAll(user: UserPayload) {
    const products = await this.prisma.product.findMany({
      where: {
        recipeVersion: {
          isActive: true,
          recipeFamily: {
            tenantId: user.tenantId,
          },
        },
      },
      include: {
        recipeVersion: {
          include: {
            recipeFamily: true,
          },
        },
        _count: {
          select: { tasks: true },
        },
      },
    });

    return products.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.recipeVersion.recipeFamily.name,
      weight: p.weight,
      rating: 4.8,
      publicCount: p._count.tasks,
      ingredients: [],
    }));
  }

  /**
   * 获取单个最终产品的完整详情，基于其激活的版本。
   */
  async findOne(id: string, user: UserPayload) {
    const product = await this.prisma.product.findFirst({
      where: {
        id,
        recipeVersion: {
          isActive: true,
          recipeFamily: {
            tenantId: user.tenantId,
          },
        },
      },
      include: {
        recipeVersion: {
          include: {
            recipeFamily: true,
            doughs: {
              include: {
                ingredients: {
                  include: {
                    ingredient: true,
                  },
                },
              },
            },
            procedures: true,
          },
        },
        mixIns: { include: { ingredient: true } },
        addOns: { include: { extra: true } },
        procedures: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`ID为 ${id} 的产品不存在或无权访问`);
    }

    return product;
  }

  /**
   * 获取指定配方家族的所有版本列表
   */
  async findAllVersions(familyId: string, user: UserPayload) {
    const family = await this.prisma.recipeFamily.findFirst({
      where: { id: familyId, tenantId: user.tenantId },
    });
    if (!family) {
      throw new NotFoundException(
        `ID为 ${familyId} 的配方家族不存在或无权访问`,
      );
    }
    return this.prisma.recipeVersion.findMany({
      where: { recipeFamilyId: familyId },
      orderBy: { versionNumber: 'desc' },
    });
  }

  /**
   * 激活指定的配方版本
   */
  async activateVersion(
    familyId: string,
    versionId: string,
    user: UserPayload,
  ) {
    // 权限校验
    if (user.role === Role.BAKER) {
      throw new ForbiddenException('仅老板或主管可以激活配方版本。');
    }
    return this.prisma.$transaction(async (tx) => {
      const version = await tx.recipeVersion.findFirst({
        where: {
          id: versionId,
          recipeFamilyId: familyId,
          recipeFamily: { tenantId: user.tenantId },
        },
      });
      if (!version) {
        throw new NotFoundException('指定的配方版本不存在或无权操作');
      }
      await tx.recipeVersion.updateMany({
        where: { recipeFamilyId: familyId },
        data: { isActive: false },
      });
      const activatedVersion = await tx.recipeVersion.update({
        where: { id: versionId },
        data: { isActive: true },
      });
      return activatedVersion;
    });
  }

  /**
   * 基于最新版本创建一个新的配方版本
   */
  async createVersion(
    familyId: string,
    versionName: string,
    user: UserPayload,
  ) {
    // 权限校验
    if (user.role === Role.BAKER) {
      throw new ForbiddenException('仅老板或主管可以创建新版本。');
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. 找到最新的版本
      const latestVersion = await tx.recipeVersion.findFirst({
        where: {
          recipeFamilyId: familyId,
          recipeFamily: { tenantId: user.tenantId },
        },
        orderBy: { versionNumber: 'desc' },
        include: {
          doughs: { include: { ingredients: true } },
          products: {
            include: { mixIns: true, addOns: true, procedures: true },
          },
          procedures: true,
        },
      });

      if (!latestVersion) {
        throw new NotFoundException('配方家族不存在或无权操作');
      }

      // 2. 创建新版本记录
      const newVersion = await tx.recipeVersion.create({
        data: {
          name: versionName,
          versionNumber: latestVersion.versionNumber + 1,
          isActive: false, // 新版本默认不激活
          recipeFamilyId: familyId,
        },
      });

      // 3. 复制所有关联数据
      // 复制面团
      for (const dough of latestVersion.doughs) {
        await tx.dough.create({
          data: {
            name: dough.name,
            isPreDough: dough.isPreDough,
            targetTemp: dough.targetTemp,
            lossRatio: dough.lossRatio,
            recipeVersionId: newVersion.id,
            ingredients: {
              create: dough.ingredients.map((ing) => ({
                ratio: ing.ratio,
                isFlour: ing.isFlour,
                ingredientId: ing.ingredientId,
              })),
            },
          },
        });
      }

      // 复制产品
      for (const product of latestVersion.products) {
        await tx.product.create({
          data: {
            name: product.name,
            weight: product.weight,
            recipeVersionId: newVersion.id,
            mixIns: {
              create: product.mixIns.map((mixIn) => ({
                ratio: mixIn.ratio,
                ingredientId: mixIn.ingredientId,
              })),
            },
            addOns: {
              create: product.addOns.map((addOn) => ({
                weight: addOn.weight,
                type: addOn.type,
                extraId: addOn.extraId,
              })),
            },
            procedures: {
              create: product.procedures.map((proc) => ({
                step: proc.step,
                name: proc.name,
                description: proc.description,
              })),
            },
          },
        });
      }

      // 复制通用工序
      if (latestVersion.procedures && latestVersion.procedures.length > 0) {
        await tx.procedure.createMany({
          data: latestVersion.procedures.map((proc) => ({
            step: proc.step,
            name: proc.name,
            description: proc.description,
            recipeVersionId: newVersion.id,
          })),
        });
      }

      return newVersion;
    });
  }
}
