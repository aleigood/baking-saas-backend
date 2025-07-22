/**
 * 文件路径: src/recipes/recipes.service.ts
 * 文件描述: (版本化重构) 实现了完整的配方版本管理和损耗率功能。
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateRecipeFamilyDto } from './dto/create-recipe.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@Injectable()
export class RecipesService {
  constructor(private prisma: PrismaService) {}

  /**
   * [核心更新] 创建一个配方家族及其首个版本。
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

      // 2. [新增] 创建首个配方版本 (RecipeVersion)
      const recipeVersion = await tx.recipeVersion.create({
        data: {
          recipeFamilyId: recipeFamily.id,
          versionNumber: 1,
          name: '初始版本', // Default name for the first version
          isActive: true,
        },
      });

      // 3. 处理并创建所有面团 (Doughs) 及其原料，关联到新版本
      for (const doughDto of doughs) {
        // 确保所有原料都已存在，如果不存在则创建
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
            lossRatio: doughDto.lossRatio || 0, // [新增] 处理损耗率
            recipeVersionId: recipeVersion.id, // 关联到版本
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
            recipeVersionId: recipeVersion.id, // 关联到版本
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
   * [核心更新] 获取当前店铺所有最终产品列表，仅包含激活版本的产品。
   * @param user 当前用户信息
   */
  async findAll(user: UserPayload) {
    const products = await this.prisma.product.findMany({
      where: {
        recipeVersion: {
          isActive: true, // 只查找激活版本下的产品
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
      rating: 4.8, // 模拟数据
      publicCount: p._count.tasks,
      ingredients: [],
    }));
  }

  /**
   * [核心更新] 获取单个最终产品的完整详情，基于其激活的版本。
   * @param id 产品ID
   * @param user 当前用户信息
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
   * [新增] 获取指定配方家族的所有版本列表
   * @param familyId 配方家族ID
   * @param user 当前用户信息
   */
  async findAllVersions(familyId: string, user: UserPayload) {
    // 首先验证该配方家族是否属于当前用户的租户
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
   * [新增] 激活指定的配方版本
   * @param familyId 配方家族ID
   * @param versionId 要激活的版本ID
   * @param user 当前用户信息
   */
  async activateVersion(
    familyId: string,
    versionId: string,
    user: UserPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 1. 验证该配方家族和版本是否属于当前用户的租户
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

      // 2. 将该家族下的所有版本都设为非激活
      await tx.recipeVersion.updateMany({
        where: { recipeFamilyId: familyId },
        data: { isActive: false },
      });

      // 3. 将指定版本设为激活
      const activatedVersion = await tx.recipeVersion.update({
        where: { id: versionId },
        data: { isActive: true },
      });

      return activatedVersion;
    });
  }
}
