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

@Injectable()
export class SuperAdminService {
  constructor(private prisma: PrismaService) {}

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
