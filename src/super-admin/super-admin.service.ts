/**
 * 文件路径: src/super-admin/super-admin.service.ts
 * 文件描述: [修改] 调整店铺与老板的关联逻辑，并为店铺列表返回老板信息。
 */
import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateOwnerDto } from './dto/create-owner.dto';
import * as bcrypt from 'bcrypt';
import {
  Prisma,
  Role,
  SystemRole,
  TenantStatus,
  UserStatus,
  User, // [新增] 导入 User 类型
} from '@prisma/client';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { RecipesService } from '../recipes/recipes.service';
import { CreateRecipeFamilyDto } from '../recipes/dto/create-recipe.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { DashboardStatsDto } from './dto/dashboard-stats.dto';
import { PaginationQueryDto } from './dto/query.dto';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
// [新增] 导入 CreateUserDto
import { CreateUserDto } from './dto/create-user.dto';

// [新增] 定义允许排序的字段白名单，增强类型安全
const allowedTenantSortFields: (keyof Prisma.TenantOrderByWithRelationInput)[] =
  ['name', 'createdAt'];
const allowedUserSortFields: (keyof Prisma.UserOrderByWithRelationInput)[] = [
  'name',
  'email',
  'createdAt',
];

// [新增] 定义一个不包含密码哈希的用户类型，用于返回给客户端
type SafeUser = Omit<User, 'passwordHash'>;

@Injectable()
export class SuperAdminService {
  constructor(
    private prisma: PrismaService,
    private recipesService: RecipesService,
  ) {}

  /**
   * [新增] 获取仪表盘的核心统计数据
   */
  async getDashboardStats(): Promise<DashboardStatsDto> {
    const totalTenants = await this.prisma.tenant.count();
    const activeTenants = await this.prisma.tenant.count({
      where: { status: 'ACTIVE' },
    });
    const totalUsers = await this.prisma.user.count({
      where: { systemRole: null }, // 只统计普通用户，不包括超管
    });

    return {
      totalTenants,
      activeTenants,
      totalUsers,
    };
  }

  /**
   * [修改] 创建一个新店铺，并将其关联到一位已存在的老板用户
   * @param createTenantDto - 包含店铺名称和老板ID的DTO
   */
  async createTenant(createTenantDto: CreateTenantDto) {
    const { name, ownerId } = createTenantDto;

    // 检查要关联的老板用户是否存在
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerId },
    });
    if (!owner) {
      throw new NotFoundException(`ID为 ${ownerId} 的用户不存在`);
    }

    // [逻辑修正] 移除一个用户只能拥有一个店铺的限制

    // 使用事务确保原子性
    return this.prisma.$transaction(async (tx) => {
      // 1. 创建店铺
      const tenant = await tx.tenant.create({
        data: {
          name,
        },
      });

      // 2. 将老板用户关联到新创建的店铺
      await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          userId: owner.id,
          role: Role.OWNER,
        },
      });

      return tenant;
    });
  }

  /**
   * [新增] 创建一个独立的用户账号
   * @param createUserDto - 包含用户信息的DTO
   */
  async createUser(createUserDto: CreateUserDto): Promise<SafeUser> {
    const { email, password, name } = createUserDto;

    // 检查邮箱是否已被注册
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new ConflictException('该邮箱已被注册');
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        email,
        name,
        passwordHash: hashedPassword,
      },
    });

    // [修复] 使用 delete 操作符移除敏感信息，避免 ESLint 警告
    const result = { ...user };
    delete (result as { passwordHash?: string | null }).passwordHash;
    return result;
  }

  /**
   * [废弃] 此方法逻辑已被新的工作流替代
   * @deprecated
   * @param createOwnerDto - 包含老板用户信息的DTO
   */
  async createOwner(createOwnerDto: CreateOwnerDto): Promise<SafeUser> {
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
    const user = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email,
          name,
          passwordHash: hashedPassword,
        },
      });

      await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          userId: newUser.id,
          role: Role.OWNER,
        },
      });

      return newUser;
    });

    // [修复] 使用 delete 操作符移除敏感信息
    const result = { ...user };
    delete (result as { passwordHash?: string | null }).passwordHash;
    return result;
  }

  /**
   * [修改] 获取所有店铺的列表，并在返回结果中包含老板信息
   */
  async findAllTenants(queryDto: PaginationQueryDto) {
    const { page = 1, limit = 10, search, sortBy } = queryDto;
    const skip = (page - 1) * limit;

    const where: Prisma.TenantWhereInput = search
      ? {
          name: {
            contains: search,
            mode: 'insensitive', // 忽略大小写
          },
        }
      : {};

    const orderBy: Prisma.TenantOrderByWithRelationInput = {};
    if (sortBy) {
      const [field, direction] = sortBy.split(':') as [
        keyof Prisma.TenantOrderByWithRelationInput,
        'asc' | 'desc',
      ];
      if (
        allowedTenantSortFields.includes(field) &&
        (direction === 'asc' || direction === 'desc')
      ) {
        orderBy[field] = direction;
      }
    } else {
      orderBy.createdAt = 'desc'; // 默认排序
    }

    const [tenants, total] = await this.prisma.$transaction([
      this.prisma.tenant.findMany({
        where,
        include: {
          // [新增] 关联查询出店铺的老板信息
          users: {
            where: {
              role: Role.OWNER,
            },
            select: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.tenant.count({ where }),
    ]);

    // [新增] 格式化返回数据，将老板信息提取到顶层
    const formattedTenants = tenants.map((tenant) => {
      const ownerInfo = tenant.users[0]?.user;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { users, ...rest } = tenant;
      return {
        ...rest,
        owner: ownerInfo
          ? { name: ownerInfo.name, email: ownerInfo.email }
          : null,
      };
    });

    return {
      data: formattedTenants,
      total,
      page,
      limit,
    };
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
   * [修改] 获取所有用户的列表，现在返回分页数据
   */
  async findAllUsers(queryDto: PaginationQueryDto) {
    const { page = 1, limit = 10, search, sortBy } = queryDto;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const orderBy: Prisma.UserOrderByWithRelationInput = {};
    if (sortBy) {
      const [field, direction] = sortBy.split(':') as [
        keyof Prisma.UserOrderByWithRelationInput,
        'asc' | 'desc',
      ];
      // [修复] 检查字段是否在白名单内，确保类型安全
      if (
        allowedUserSortFields.includes(field) &&
        (direction === 'asc' || direction === 'desc')
      ) {
        orderBy[field] = direction;
      }
    } else {
      orderBy.createdAt = 'desc';
    }

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          systemRole: true,
          status: true, // [新增] 返回用户状态
          createdAt: true,
          tenants: {
            select: {
              role: true,
              tenant: { select: { id: true, name: true } },
            },
          },
        },
        skip,
        take: limit,
        orderBy,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: users, total, page, limit };
  }

  /**
   * [修改] 更新用户信息，增加自我操作校验
   */
  async updateUser(
    userId: string,
    updateUserDto: UpdateUserDto,
    currentUser: UserPayload,
  ) {
    if (userId === currentUser.userId) {
      throw new ForbiddenException('无法编辑自己的账户信息。');
    }
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
   * [修改] 更新用户状态，增加对最后一个超级管理员的保护
   */
  async updateUserStatus(
    userId: string,
    status: UserStatus,
    currentUser: UserPayload,
  ) {
    if (userId === currentUser.userId) {
      throw new ForbiddenException('无法更改自己的账户状态。');
    }
    const userToUpdate = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!userToUpdate) {
      throw new NotFoundException(`ID为 ${userId} 的用户不存在`);
    }

    // [新增] 安全校验：防止停用最后一个超级管理员
    if (
      userToUpdate.systemRole === SystemRole.SUPER_ADMIN &&
      status === UserStatus.INACTIVE
    ) {
      const adminCount = await this.prisma.user.count({
        where: {
          systemRole: SystemRole.SUPER_ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
      if (adminCount <= 1) {
        throw new ForbiddenException('无法停用系统中最后一位超级管理员。');
      }
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { status },
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
