import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import {
    EntitlementTier,
    ApplicationStatus,
    GlobalRole,
    PaymentOrderStatus,
    Prisma,
    SubscriptionStatus,
    TenantRole,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { QueryDto } from './dto/query.dto';
// [G-Code-Note] [核心修改] 导入批量导入 DTO
import { CreateRecipeDto } from '../recipes/dto/create-recipe.dto';
import { BatchImportRecipeDto } from '../recipes/dto/batch-import-recipe.dto'; // 假设这是你的 DTO 路径
import { RecipesService } from '../recipes/recipes.service';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
import { UpdateTenantStatusDto } from './dto/update-tenant-status.dto';
import { UpsertSubscriptionPlanDto } from './dto/upsert-subscription-plan.dto';
import { CreateTenantSubscriptionDto } from './dto/create-tenant-subscription.dto';
import { UpdateTenantSubscriptionDto } from './dto/update-tenant-subscription.dto';
import { EntitlementsService } from '../billing/entitlements.service';
import { UpsertIngredientPresetDto } from './dto/upsert-ingredient-preset.dto';
import { ReviewStoreApplicationDto } from './dto/review-store-application.dto';
import { getUserDisplayName } from '../common/utils/user-display.util';

@Injectable()
export class SuperAdminService {
    constructor(
        private prisma: PrismaService,
        private recipesService: RecipesService,
        private entitlementsService: EntitlementsService,
    ) {}

    async findRecipeImportJobs(page = 1, limit = 20, tenantId?: string) {
        const safePage = Math.max(1, page);
        const safeLimit = Math.min(100, Math.max(1, limit));
        const where = tenantId ? { tenantId } : {};
        const [data, total] = await Promise.all([
            this.prisma.recipeImportJob.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (safePage - 1) * safeLimit,
                take: safeLimit,
                select: {
                    id: true,
                    tenantId: true,
                    status: true,
                    fileName: true,
                    mimeType: true,
                    errorMessage: true,
                    startedAt: true,
                    completedAt: true,
                    createdAt: true,
                    diagnosticExpiresAt: true,
                    tenant: { select: { name: true } },
                },
            }),
            this.prisma.recipeImportJob.count({ where }),
        ]);
        return { data, meta: { total, page: safePage, limit: safeLimit, lastPage: Math.ceil(total / safeLimit) } };
    }

    async getRecipeImportDiagnostic(jobId: string) {
        const job = await this.prisma.recipeImportJob.findUnique({
            where: { id: jobId },
            include: { tenant: { select: { name: true } } },
        });
        if (!job) throw new NotFoundException('智能导入任务不存在');
        if (!job.diagnosticExpiresAt || job.diagnosticExpiresAt <= new Date()) {
            throw new NotFoundException('该任务的诊断数据已过期');
        }
        return {
            manifest: {
                jobId: job.id,
                tenantId: job.tenantId,
                tenantName: job.tenant.name,
                status: job.status,
                fileName: job.fileName,
                mimeType: job.mimeType,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                completedAt: job.completedAt,
                errorMessage: job.errorMessage,
            },
            source: {
                text: job.sourceText,
                fileName: job.fileName,
                mimeType: job.mimeType,
                fileBase64: job.sourceData ? Buffer.from(job.sourceData).toString('base64') : null,
            },
            model: job.diagnosticData,
            normalizedResult: job.result,
        };
    }

    // --- Dashboard ---
    async getDashboardStats() {
        const [totalTenants, totalUsers, totalRecipes, totalTasks, activeSubscriptions, paidOrdersAggregate] =
            await Promise.all([
                this.prisma.tenant.count(),
                this.prisma.user.count({
                    where: { globalRole: { not: GlobalRole.SUPER_ADMIN }, profileCompletedAt: { not: null } },
                }),
                this.prisma.recipeFamily.count({
                    where: { deletedAt: null },
                }),
                this.prisma.productionTask.count({
                    where: { deletedAt: null },
                }),
                this.prisma.tenantSubscription.count({
                    where: {
                        status: SubscriptionStatus.ACTIVE,
                        expiresAt: { gt: new Date() },
                    },
                }),
                this.prisma.paymentOrder.aggregate({
                    where: { status: PaymentOrderStatus.PAID },
                    _sum: { amountInCents: true },
                }),
            ]);

        return {
            totalTenants,
            totalUsers,
            totalRecipes,
            totalTasks,
            activeSubscriptions,
            paidAmountInCents: paidOrdersAggregate._sum.amountInCents ?? 0,
        };
    }

    async findStoreApplications(query: QueryDto & { status?: ApplicationStatus }) {
        const page = Number(query.page || 1);
        const limit = Number(query.limit || 10);
        const where: Prisma.StoreApplicationWhereInput = {
            ...(query.status ? { status: query.status } : {}),
            ...(query.search
                ? {
                      OR: [
                          { storeName: { contains: query.search, mode: 'insensitive' } },
                          { address: { contains: query.search, mode: 'insensitive' } },
                          { contactName: { contains: query.search, mode: 'insensitive' } },
                          { contactPhone: { contains: query.search } },
                      ],
                  }
                : {}),
        };
        const [data, total] = await Promise.all([
            this.prisma.storeApplication.findMany({
                where,
                include: {
                    applicant: { select: { id: true, name: true, avatarUrl: true } },
                    reviewer: { select: { id: true, name: true } },
                    createdTenant: { select: { id: true, name: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.storeApplication.count({ where }),
        ]);
        return { data, meta: { total, page, limit, lastPage: Math.ceil(total / limit) } };
    }

    async approveStoreApplication(id: string, reviewerId: string, dto: ReviewStoreApplicationDto) {
        const application = await this.prisma.storeApplication.findUnique({ where: { id } });
        if (!application || application.status !== ApplicationStatus.PENDING)
            throw new NotFoundException('申请不存在或已处理');
        return this.prisma.$transaction(async (tx) => {
            const claimed = await tx.storeApplication.updateMany({
                where: { id, status: ApplicationStatus.PENDING },
                data: {
                    status: ApplicationStatus.APPROVED,
                    reviewedById: reviewerId,
                    reviewedAt: new Date(),
                    reviewNote: dto.reviewNote?.trim() || null,
                },
            });
            if (!claimed.count) throw new ConflictException('该申请已经被处理');
            const tenant = await tx.tenant.create({
                data: {
                    name: application.storeName,
                    address: application.address,
                    members: { create: { userId: application.applicantId, role: TenantRole.OWNER, status: 'ACTIVE' } },
                },
            });
            await tx.storeApplication.update({ where: { id }, data: { createdTenantId: tenant.id } });
            return { approved: true, tenant };
        });
    }

    async rejectStoreApplication(id: string, reviewerId: string, dto: ReviewStoreApplicationDto) {
        const result = await this.prisma.storeApplication.updateMany({
            where: { id, status: ApplicationStatus.PENDING },
            data: {
                status: ApplicationStatus.REJECTED,
                reviewedById: reviewerId,
                reviewedAt: new Date(),
                reviewNote: dto.reviewNote?.trim() || null,
            },
        });
        if (!result.count) throw new NotFoundException('申请不存在或已处理');
        return { rejected: true };
    }

    // --- Subscription Plan Management ---
    async findAllSubscriptionPlans() {
        return this.prisma.subscriptionPlan.findMany({
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
    }

    async createSubscriptionPlan(dto: UpsertSubscriptionPlanDto) {
        return this.prisma.subscriptionPlan.create({
            data: {
                code: dto.code,
                name: dto.name,
                durationDays: dto.durationDays,
                priceInCents: dto.priceInCents,
                originalPriceInCents: dto.originalPriceInCents,
                isActive: dto.isActive ?? true,
                sortOrder: dto.sortOrder ?? 0,
            },
        });
    }

    async updateSubscriptionPlan(id: string, dto: UpsertSubscriptionPlanDto) {
        return this.prisma.subscriptionPlan.update({
            where: { id },
            data: {
                code: dto.code,
                name: dto.name,
                durationDays: dto.durationDays,
                priceInCents: dto.priceInCents,
                originalPriceInCents: dto.originalPriceInCents,
                isActive: dto.isActive,
                sortOrder: dto.sortOrder,
            },
        });
    }

    async findAllIngredientPresets() {
        const presets = await this.prisma.ingredientPreset.findMany({
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        });
        return presets.map((preset) => ({
            ...preset,
            waterContent: preset.waterContent.toNumber(),
        }));
    }

    async createIngredientPreset(dto: UpsertIngredientPresetDto) {
        const name = dto.name.trim();
        const existing = await this.prisma.ingredientPreset.findUnique({ where: { name } });
        if (existing) throw new BadRequestException(`预设原料“${name}”已存在`);
        const preset = await this.prisma.ingredientPreset.create({
            data: {
                name,
                isFlour: dto.isFlour,
                waterContent: new Prisma.Decimal(dto.waterContent),
                isActive: dto.isActive ?? true,
                sortOrder: dto.sortOrder ?? 0,
            },
        });
        return { ...preset, waterContent: preset.waterContent.toNumber() };
    }

    async updateIngredientPreset(id: string, dto: UpsertIngredientPresetDto) {
        const preset = await this.prisma.ingredientPreset.findUnique({ where: { id }, select: { id: true } });
        if (!preset) throw new NotFoundException('预设原料不存在');
        const name = dto.name.trim();
        const duplicate = await this.prisma.ingredientPreset.findFirst({ where: { name, id: { not: id } } });
        if (duplicate) throw new BadRequestException(`预设原料“${name}”已存在`);
        const updated = await this.prisma.ingredientPreset.update({
            where: { id },
            data: {
                name,
                isFlour: dto.isFlour,
                waterContent: new Prisma.Decimal(dto.waterContent),
                isActive: dto.isActive ?? true,
                sortOrder: dto.sortOrder ?? 0,
            },
        });
        return { ...updated, waterContent: updated.waterContent.toNumber() };
    }

    // --- Subscription Management ---
    async findAllSubscriptions(queryDto: QueryDto) {
        const { search, page = '1', limit = '10', sortBy = 'createdAt', order = 'desc' } = queryDto;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.TenantSubscriptionWhereInput = search
            ? {
                  OR: [
                      { tenant: { name: { contains: search, mode: 'insensitive' } } },
                      { plan: { name: { contains: search, mode: 'insensitive' } } },
                  ],
              }
            : {};

        const [subscriptions, total] = await Promise.all([
            this.prisma.tenantSubscription.findMany({
                where,
                include: {
                    tenant: {
                        include: {
                            members: {
                                where: { role: TenantRole.OWNER },
                                include: {
                                    user: {
                                        select: {
                                            id: true,
                                            phone: true,
                                            name: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                    plan: true,
                },
                orderBy: { [sortBy]: order },
                skip: (pageNum - 1) * limitNum,
                take: limitNum,
            }),
            this.prisma.tenantSubscription.count({ where }),
        ]);

        return {
            data: subscriptions,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                lastPage: Math.ceil(total / limitNum),
            },
        };
    }

    async createTenantSubscription(dto: CreateTenantSubscriptionDto) {
        const [tenant, plan, entitlementPolicy] = await Promise.all([
            this.prisma.tenant.findUnique({ where: { id: dto.tenantId } }),
            this.prisma.subscriptionPlan.findUnique({ where: { id: dto.planId } }),
            this.entitlementsService.getDefaultPolicyForTier(EntitlementTier.PRO),
        ]);

        if (!tenant) {
            throw new NotFoundException(`ID为 ${dto.tenantId} 的店铺不存在`);
        }
        if (!plan) {
            throw new NotFoundException(`ID为 ${dto.planId} 的套餐不存在`);
        }

        const startsAt = dto.startsAt ? new Date(dto.startsAt) : new Date();
        const expiresAt = this.addDays(startsAt, plan.durationDays);

        return this.prisma.tenantSubscription.create({
            data: {
                tenantId: tenant.id,
                planId: plan.id,
                entitlementPolicyId: entitlementPolicy.id,
                status: SubscriptionStatus.ACTIVE,
                startsAt,
                expiresAt,
                source: dto.source ?? 'manual',
                notes: dto.notes,
            },
            include: {
                tenant: true,
                plan: true,
            },
        });
    }

    async updateTenantSubscription(id: string, dto: UpdateTenantSubscriptionDto) {
        const current = await this.prisma.tenantSubscription.findUnique({
            where: { id },
            include: { plan: true },
        });
        if (!current) {
            throw new NotFoundException(`ID为 ${id} 的订阅不存在`);
        }

        const plan = dto.planId
            ? await this.prisma.subscriptionPlan.findUnique({ where: { id: dto.planId } })
            : current.plan;

        if (!plan) {
            throw new NotFoundException(`ID为 ${dto.planId} 的套餐不存在`);
        }

        const startsAt = dto.startsAt ? new Date(dto.startsAt) : current.startsAt;
        const expiresAt = dto.expiresAt
            ? new Date(dto.expiresAt)
            : dto.planId
              ? this.addDays(startsAt, plan.durationDays)
              : undefined;

        if (expiresAt && expiresAt <= startsAt) {
            throw new BadRequestException('订阅到期时间必须晚于开始时间');
        }

        return this.prisma.tenantSubscription.update({
            where: { id },
            data: {
                planId: dto.planId,
                status: dto.status,
                startsAt: dto.startsAt ? startsAt : undefined,
                expiresAt,
                notes: dto.notes,
            },
            include: {
                tenant: true,
                plan: true,
            },
        });
    }

    // --- Payment Order Management ---
    async findAllPaymentOrders(queryDto: QueryDto) {
        const { search, page = '1', limit = '10', sortBy = 'createdAt', order = 'desc' } = queryDto;
        const pageNum = parseInt(page, 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.PaymentOrderWhereInput = search
            ? {
                  OR: [
                      { orderNo: { contains: search, mode: 'insensitive' } },
                      { transactionId: { contains: search, mode: 'insensitive' } },
                      { tenant: { name: { contains: search, mode: 'insensitive' } } },
                      { user: { phone: { contains: search } } },
                  ],
              }
            : {};

        const [orders, total] = await Promise.all([
            this.prisma.paymentOrder.findMany({
                where,
                include: {
                    tenant: true,
                    user: {
                        select: {
                            id: true,
                            phone: true,
                            name: true,
                        },
                    },
                    plan: true,
                    subscription: true,
                },
                orderBy: { [sortBy]: order },
                skip: (pageNum - 1) * limitNum,
                take: limitNum,
            }),
            this.prisma.paymentOrder.count({ where }),
        ]);

        return {
            data: orders,
            meta: {
                total,
                page: pageNum,
                limit: limitNum,
                lastPage: Math.ceil(total / limitNum),
            },
        };
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
                // 统计每个店铺的配方数量
                _count: {
                    select: {
                        recipeFamilies: {
                            where: { deletedAt: null }, // 只统计未被软删除的配方
                        },
                    },
                },
            },
            orderBy,
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        const total = await this.prisma.tenant.count({ where });

        // 在返回的数据中加入配方数量
        const data = await Promise.all(
            tenants.map(async (tenant) => {
                const ownerInfo = tenant.members[0]?.user;
                const entitlement = await this.entitlementsService.getSummary(tenant.id);
                return {
                    id: tenant.id,
                    name: tenant.name,
                    address: tenant.address,
                    status: tenant.status,
                    recipeCount: tenant._count.recipeFamilies,
                    createdAt: tenant.createdAt,
                    updatedAt: tenant.updatedAt,
                    ownerName: ownerInfo?.name?.trim() || ownerInfo?.phone || '微信用户',
                    ownerId: ownerInfo?.id,
                    subscriptionState: entitlement.state,
                    entitledUntil: entitlement.entitledUntil,
                };
            }),
        );

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
        const { name, address, ownerId } = dto;
        const ownerExists = await this.prisma.user.findUnique({
            where: { id: ownerId },
        });
        if (!ownerExists) {
            throw new NotFoundException(`ID为 ${ownerId} 的用户不存在`);
        }
        return this.prisma.tenant.create({
            data: {
                name,
                address,
                members: {
                    create: {
                        userId: ownerId,
                        role: TenantRole.OWNER,
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
        const where: Prisma.UserWhereInput = {
            profileCompletedAt: { not: null },
            ...(search
                ? {
                      OR: [
                          { phone: { contains: search, mode: 'insensitive' } },
                          { name: { contains: search, mode: 'insensitive' } },
                          { wechatNickname: { contains: search, mode: 'insensitive' } },
                          { tenants: { some: { tenant: { name: { contains: search, mode: 'insensitive' } } } } },
                      ],
                  }
                : {}),
        };

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
            name: user.name, // [新增] 返回用户姓名
            wechatNickname: user.wechatNickname,
            displayName: getUserDisplayName(user),
            phone: user.phone,
            globalRole: user.globalRole,
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
        const { name, phone, password } = dto;
        const hashedPassword = await bcrypt.hash(password, 10);
        return this.prisma.user.create({
            data: {
                name,
                phone,
                phoneVerifiedAt: new Date(),
                profileCompletedAt: new Date(),
                password: hashedPassword,
            },
        });
    }

    async updateUser(id: string, dto: UpdateUserDto) {
        const data: Prisma.UserUpdateInput = {};
        if (dto.name) data.name = dto.name; // [修改] 允许更新 name
        // [修改] 移除 phone 的更新逻辑
        if (dto.globalRole) data.globalRole = dto.globalRole;
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
    async createRecipeForTenant(tenantId: string, actorUserId: string, recipeDto: CreateRecipeDto) {
        return this.recipesService.create(tenantId, actorUserId, recipeDto);
    }

    // [G-Code-Note] [核心新增] 批量导入配方到指定店铺
    async batchImportRecipesForTenant(tenantId: string, actorUserId: string, recipesDto: BatchImportRecipeDto[]) {
        // 1. 作为超级管理员，我们首先要找到这个店铺的 OWNER
        //    因为 recipesService 内部的逻辑是基于 OWNER 权限的
        const tenantOwner = await this.prisma.tenantUser.findFirst({
            where: {
                tenantId: tenantId,
                role: TenantRole.OWNER,
            },
            select: {
                userId: true,
            },
        });

        if (!tenantOwner || !tenantOwner.userId) {
            throw new NotFoundException(`无法找到 ID 为 ${tenantId} 的店铺的 OWNER，无法代表其执行导入。`);
        }

        // 2. [核心] 调用 recipesService 的批量导入功能
        // 我们传入 OWNER 的 userId，并限定只导入到这一个 tenantId
        return this.recipesService.batchImportRecipes(tenantOwner.userId, recipesDto, [tenantId], actorUserId);
    }

    async findAuditLogs(query: QueryDto) {
        const page = Number(query.page || 1);
        const limit = Number(query.limit || 20);
        const search = query.search?.trim();
        const matchingActors = search
            ? await this.prisma.user.findMany({
                  where: {
                      OR: [
                          { name: { contains: search, mode: 'insensitive' } },
                          { phone: { contains: search, mode: 'insensitive' } },
                          { wechatNickname: { contains: search, mode: 'insensitive' } },
                      ],
                  },
                  select: { id: true },
                  take: 50,
              })
            : [];
        const conditions: Prisma.AuditLogWhereInput[] = [];
        if (search) {
            conditions.push({
                OR: [
                    { action: { contains: search, mode: 'insensitive' } },
                    { path: { contains: search, mode: 'insensitive' } },
                    { actorUserId: { contains: search, mode: 'insensitive' } },
                    { actorUserId: { in: matchingActors.map((actor) => actor.id) } },
                ],
            });
        }
        if (query.category) conditions.push({ metadata: { path: ['category'], equals: query.category } });
        if (query.result === 'SUCCESS') conditions.push({ statusCode: { lt: 400 } });
        if (query.result === 'FAILED') conditions.push({ statusCode: { gte: 400 } });
        const where: Prisma.AuditLogWhereInput = conditions.length ? { AND: conditions } : {};
        const [data, total] = await Promise.all([
            this.prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.auditLog.count({ where }),
        ]);
        const actorIds = [...new Set(data.flatMap((record) => (record.actorUserId ? [record.actorUserId] : [])))];
        const tenantIds = [
            ...new Set(
                data.flatMap((record) => (record.targetType === 'tenant' && record.targetId ? [record.targetId] : [])),
            ),
        ];
        const applicationIds = [
            ...new Set(
                data.flatMap((record) =>
                    record.targetType === 'store-application' && record.targetId ? [record.targetId] : [],
                ),
            ),
        ];
        const [actors, tenants, applications] = await Promise.all([
            this.prisma.user.findMany({
                where: { id: { in: actorIds } },
                select: { id: true, name: true, phone: true, wechatNickname: true },
            }),
            this.prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
            this.prisma.storeApplication.findMany({
                where: { id: { in: applicationIds } },
                select: { id: true, storeName: true, contactName: true },
            }),
        ]);
        const actorMap = new Map(actors.map((actor) => [actor.id, actor]));
        const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
        const applicationMap = new Map(
            applications.map((application) => [
                application.id,
                `${application.storeName} · ${application.contactName}`,
            ]),
        );
        const enrichedData = data.map((record) => {
            const actor = record.actorUserId ? actorMap.get(record.actorUserId) : undefined;
            const targetName =
                record.targetType === 'tenant' && record.targetId
                    ? tenantMap.get(record.targetId)
                    : record.targetType === 'store-application' && record.targetId
                      ? applicationMap.get(record.targetId)
                      : undefined;
            return {
                ...record,
                actor: actor
                    ? {
                          id: actor.id,
                          displayName: getUserDisplayName(actor),
                          phone: actor.phone,
                      }
                    : null,
                targetName: targetName || null,
            };
        });
        return { data: enrichedData, meta: { total, page, limit, lastPage: Math.ceil(total / limit) } };
    }

    private addDays(date: Date, days: number) {
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
    }
}
