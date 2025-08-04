import { Injectable, NotFoundException } from '@nestjs/common';
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
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateTenantStatusDto } from './dto/update-tenant-status.dto';

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
        const { search, page = '1', limit = '10', sortBy = 'createdAt', order = 'desc' } = queryDto;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.TenantWhereInput = search
            ? {
                  OR: [
                      { name: { contains: search, mode: 'insensitive' } },
                      { members: { some: { role: 'OWNER', user: { phone: { contains: search } } } } },
                  ],
              }
            : {};

        const orderBy = { [sortBy]: order };

        const tenants = await this.prisma.tenant.findMany({
            where,
            include: {
                members: {
                    where: { role: 'OWNER' },
                    include: { user: true },
                },
            },
            orderBy,
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        const total = await this.prisma.tenant.count({ where });

        const data = tenants.map((tenant) => {
            const ownerInfo = tenant.members[0]?.user;
            return {
                id: tenant.id,
                name: tenant.name,
                status: tenant.status,
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
        const { name, ownerId } = dto;
        const ownerExists = await this.prisma.user.findUnique({
            where: { id: ownerId },
        });
        if (!ownerExists) {
            throw new NotFoundException(`ID为 ${ownerId} 的用户不存在`);
        }
        return this.prisma.tenant.create({
            data: {
                name,
                members: {
                    create: {
                        userId: ownerId,
                        role: Role.OWNER,
                        status: 'ACTIVE',
                    },
                },
            },
        });
    }

    async updateTenant(id: string, dto: UpdateTenantDto) {
        return this.prisma.tenant.update({ where: { id }, data: dto });
    }

    async updateTenantStatus(id: string, dto: UpdateTenantStatusDto) {
        return this.prisma.tenant.update({
            where: { id },
            data: { status: dto.status },
        });
    }

    async deleteTenant(id: string) {
        return this.prisma.$transaction(async (tx) => {
            await tx.tenantUser.deleteMany({ where: { tenantId: id } });
            return tx.tenant.delete({ where: { id } });
        });
    }

    // --- User Management ---
    async findAllUsers(queryDto: QueryDto) {
        const { search, page = '1', limit = '10', sortBy = 'createdAt', order = 'desc' } = queryDto;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);
        const where: Prisma.UserWhereInput = search ? { phone: { contains: search, mode: 'insensitive' } } : {};
        const orderBy = { [sortBy]: order };

        const users = await this.prisma.user.findMany({
            where,
            include: {
                tenants: {
                    include: {
                        tenant: true,
                    },
                },
            },
            orderBy,
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });
        const total = await this.prisma.user.count({ where });
        const data = users.map((user) => ({
            id: user.id,
            phone: user.phone,
            role: user.role,
            status: user.status,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
            tenants: user.tenants.map((tenantUser) => ({
                role: tenantUser.role,
                tenant: {
                    id: tenantUser.tenant.id,
                    name: tenantUser.tenant.name,
                },
            })),
        }));
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

    async updateUserStatus(id: string, dto: UpdateUserStatusDto) {
        return this.prisma.user.update({
            where: { id },
            data: { status: dto.status },
        });
    }

    async deleteUser(id: string) {
        return this.prisma.$transaction(async (tx) => {
            await tx.tenantUser.deleteMany({ where: { userId: id } });
            return tx.user.delete({ where: { id } });
        });
    }

    // --- Recipe Management ---
    async createRecipeForTenant(tenantId: string, recipeDto: CreateRecipeDto) {
        return this.recipesService.create(tenantId, recipeDto);
    }
}
