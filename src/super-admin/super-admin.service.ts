import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { QueryDto } from './dto/query.dto';
import { CreateRecipeDto } from '../recipes/dto/create-recipe.dto';
import { RecipesService } from '../recipes/recipes.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';

@Injectable()
export class SuperAdminService {
  constructor(
    private prisma: PrismaService,
    private recipesService: RecipesService,
  ) {}

  // --- Dashboard ---
  async getDashboardStats() {
    const totalTenants = await this.prisma.tenant.count();
    const totalUsers = await this.prisma.user.count({
      where: { role: { not: Role.SUPER_ADMIN } },
    });
    const totalRecipes = await this.prisma.recipeFamily.count({
      where: { deletedAt: null },
    });
    const totalTasks = await this.prisma.productionTask.count({
      where: { deletedAt: null },
    });

    return { totalTenants, totalUsers, totalRecipes, totalTasks };
  }

  // --- Tenant Management ---
  async findAllTenants(queryDto: QueryDto) {
    const {
      search,
      page = '1',
      limit = '10',
      sortBy = 'createdAt',
      order = 'desc',
    } = queryDto;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const where: Prisma.TenantWhereInput = search
      ? { name: { contains: search, mode: 'insensitive' } }
      : {};

    const tenants = await this.prisma.tenant.findMany({
      where,
      include: {
        members: {
          where: { role: 'OWNER' },
          include: { user: true },
        },
      },
      orderBy: { [sortBy]: order },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    });

    const total = await this.prisma.tenant.count({ where });

    const data = tenants.map((tenant) => {
      const ownerInfo = tenant.members[0]?.user;
      // 修复：显式构建返回对象，而不是使用解构来排除字段
      return {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
        ownerName: ownerInfo?.phone || 'N/A',
        ownerId: ownerInfo?.id,
      };
    });

    return {
      data,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        lastPage: Math.ceil(total / limitNum),
      },
    };
  }

  async createTenant(dto: CreateTenantDto) {
    return this.prisma.tenant.create({ data: { name: dto.name } });
  }

  async updateTenant(id: string, dto: UpdateTenantDto) {
    return this.prisma.tenant.update({ where: { id }, data: dto });
  }

  async deleteTenant(id: string) {
    return this.prisma.tenant.delete({ where: { id } });
  }

  // --- User Management ---
  async findAllUsers(queryDto: QueryDto) {
    const {
      search,
      page = '1',
      limit = '10',
      sortBy = 'createdAt',
      order = 'desc',
    } = queryDto;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const where: Prisma.UserWhereInput = search
      ? { phone: { contains: search, mode: 'insensitive' } }
      : {};

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { [sortBy]: order },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    });

    const total = await this.prisma.user.count({ where });

    return {
      // 修复：显式构建返回对象，只包含安全的字段
      data: users.map((user) => ({
        id: user.id,
        phone: user.phone,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        lastPage: Math.ceil(total / limitNum),
      },
    };
  }

  async createUser(dto: CreateUserDto) {
    const { phone, password } = dto;
    const hashedPassword = await bcrypt.hash(password, 10);
    return this.prisma.user.create({
      data: {
        phone,
        password: hashedPassword,
      },
    });
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    const data: Prisma.UserUpdateInput = {};
    if (dto.phone) data.phone = dto.phone;
    if (dto.role) data.role = dto.role;
    if (dto.status) data.status = dto.status;

    if (dto.password) {
      data.password = await bcrypt.hash(dto.password, 10);
    }
    return this.prisma.user.update({ where: { id }, data });
  }

  async deleteUser(id: string) {
    return this.prisma.user.delete({ where: { id } });
  }

  // --- Recipe Management ---
  async createRecipeForTenant(tenantId: string, recipeDto: CreateRecipeDto) {
    return this.recipesService.create(tenantId, recipeDto);
  }
}
