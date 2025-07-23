/**
 * 文件路径: src/super-admin/super-admin.service.ts
 * 文件描述: [新增] 包含超级管理员功能的核心业务逻辑。
 */
import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateOwnerDto } from './dto/create-owner.dto';
import * as bcrypt from 'bcrypt';
import { Role, TenantStatus } from '@prisma/client';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { RecipesService } from '../recipes/recipes.service';
import { CreateRecipeFamilyDto } from '../recipes/dto/create-recipe.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class SuperAdminService {
  constructor(
    private prisma: PrismaService,
    private recipesService: RecipesService,
  ) {}

  /**
   * [新增] 创建一个新的店铺
   * @param createTenantDto - 包含店铺名称的DTO
   */
  async createTenant(createTenantDto: CreateTenantDto) {
    return this.prisma.tenant.create({
      data: {
        name: createTenantDto.name,
      },
    });
  }

  /**
   * [新增] 创建一个老板(OWNER)用户并将其关联到指定店铺
   * @param createOwnerDto - 包含老板用户信息的DTO
   */
  async createOwner(createOwnerDto: CreateOwnerDto) {
    const { email, password, name, tenantId } = createOwnerDto;

    // 检查店铺是否存在
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new NotFoundException(`ID为 ${tenantId} 的店铺不存在`);
    }

    // 检查邮箱是否已被注册
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException('该邮箱已被注册');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // 使用事务确保用户创建和关联操作的原子性
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash: hashedPassword,
          // 注意：此处不设置 systemRole，默认为普通用户
        },
      });

      await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: Role.OWNER, // 将用户角色设置为老板
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { passwordHash, ...result } = user;
      return result;
    });
  }

  /**
   * [新增] 获取所有店铺的列表
   */
  async findAllTenants() {
    return this.prisma.tenant.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * [新增] 更新店铺信息
   * @param tenantId 店铺ID
   * @param updateTenantDto 包含更新数据的DTO
   */
  async updateTenant(tenantId: string, updateTenantDto: UpdateTenantDto) {
    await this.findTenantOrThrow(tenantId);
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: updateTenantDto,
    });
  }

  /**
   * [新增] 停用一个店铺（软删除）
   * @param tenantId 店铺ID
   */
  async deactivateTenant(tenantId: string) {
    await this.findTenantOrThrow(tenantId);
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.INACTIVE },
    });
  }

  /**
   * [新增] 重新激活一个店铺
   * @param tenantId 店铺ID
   */
  async reactivateTenant(tenantId: string) {
    await this.findTenantOrThrow(tenantId);
    return this.prisma.tenant.update({
      where: { id: tenantId },
      data: { status: TenantStatus.ACTIVE },
    });
  }

  /**
   * [新增] 获取所有用户的列表
   */
  async findAllUsers() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        systemRole: true,
        createdAt: true,
        tenants: {
          select: {
            role: true,
            tenant: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  /**
   * [新增] 更新用户信息
   * @param userId 用户ID
   * @param updateUserDto 包含更新数据的DTO
   */
  async updateUser(userId: string, updateUserDto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`ID为 ${userId} 的用户不存在`);
    }
    return this.prisma.user.update({
      where: { id: userId },
      data: updateUserDto,
    });
  }

  /**
   * [新增] 为指定店铺导入配方
   * @param tenantId 目标店铺ID
   * @param recipeDto 配方数据
   */
  async importRecipe(tenantId: string, recipeDto: CreateRecipeFamilyDto) {
    await this.findTenantOrThrow(tenantId);

    // 模拟一个具有 OWNER 权限的用户 payload 来调用 recipesService
    // 因为 recipesService.create 有权限检查
    const mockUserPayload = {
      userId: 'super-admin-import', // 标识此操作由超管发起
      tenantId: tenantId,
      role: Role.OWNER,
    };

    return this.recipesService.create(recipeDto, mockUserPayload);
  }

  /**
   * [修改] 获取用于导入的配方JSON模板，使用更复杂的案例
   */
  getRecipeTemplateJson() {
    return {
      name: '示例：乡村面包家族',
      doughs: [
        {
          name: '液种酵头 (Poolish)',
          isPreDough: true, // 标记为酵种
          targetTemp: 24,
          lossRatio: 0.02, // 酵种损耗
          ingredients: [
            { name: 'T65面粉', ratio: 50, isFlour: true }, // 酵种中的面粉也是总面粉的一部分
            { name: '水', ratio: 50, isFlour: false },
            { name: '干酵母', ratio: 0.1, isFlour: false },
          ],
        },
        {
          name: '主面团',
          isPreDough: false,
          targetTemp: 26,
          lossRatio: 0.05,
          ingredients: [
            { name: 'T65面粉', ratio: 50, isFlour: true }, // 剩余的面粉
            { name: '水', ratio: 20, isFlour: false },
            { name: '盐', ratio: 2, isFlour: false },
            { name: '液种酵头 (Poolish)', ratio: 100.1, isFlour: false }, // 将酵种作为一种原料加入
          ],
        },
      ],
      products: [
        {
          name: '原味乡村面包',
          weight: 500,
          mixIns: [],
          addOns: [],
          procedures: [
            {
              step: 1,
              name: '烘烤',
              description: '上火230度，下火210度，烘烤25分钟。',
            },
          ],
        },
        {
          name: '核桃乡村面包',
          weight: 550,
          mixIns: [
            // 演示如何添加混合原料
            { name: '核桃仁', ratio: 10 },
          ],
          addOns: [],
          procedures: [
            {
              step: 1,
              name: '烘烤',
              description: '上火220度，下火200度，烘烤30分钟。',
            },
          ],
        },
      ],
      procedures: [
        {
          step: 1,
          name: '混合',
          description:
            '混合主面团所有材料，慢速搅拌3分钟，快速搅拌至面筋完全扩展。',
        },
        {
          step: 2,
          name: '基础发酵',
          description: '温度28度，湿度75%，发酵60分钟，期间翻面一次。',
        },
      ],
    };
  }

  /**
   * 辅助函数：查找店铺，如果不存在则抛出异常
   */
  private async findTenantOrThrow(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new NotFoundException(`ID为 ${tenantId} 的店铺不存在`);
    }
    return tenant;
  }
}
