import { BadRequestException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import {
    EntitlementPolicyStatus,
    EntitlementTier,
    Prisma,
    RecipeType,
    SubscriptionStatus,
    TenantRole,
    UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { EntitlementFeature } from './requires-feature.decorator';

export interface EntitlementPolicyConfig {
    limits: {
        mainRecipes: number | null;
        productionTasksPerMonth: number | null;
        members: number | null;
    };
    features: {
        costing: boolean;
        statistics: boolean;
        batchImport: boolean;
        export: boolean;
    };
}

export const PROFESSIONAL_TRIAL_DAYS = 14;
export const SUBSCRIPTION_GRACE_DAYS = 7;

export type EntitlementState = 'PAID' | 'TRIAL' | 'GRACE' | 'FREE';

@Injectable()
export class EntitlementsService {
    constructor(private readonly prisma: PrismaService) {}

    async getDefaultPolicyForTier(tier: EntitlementTier) {
        return this.getDefaultPolicy(tier);
    }

    async getCatalog() {
        const [plans, freePolicy, proPolicy, settings] = await Promise.all([
            this.prisma.subscriptionPlan.findMany({
                where: { isActive: true },
                orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            }),
            this.getDefaultPolicy(EntitlementTier.FREE),
            this.getDefaultPolicy(EntitlementTier.PRO),
            this.getBillingSettings(),
        ]);
        return {
            catalogVersion: `${freePolicy.id}:${proPolicy.id}:${plans.map((plan) => plan.updatedAt.getTime()).join('.')}`,
            updatedAt: new Date(
                Math.max(
                    freePolicy.updatedAt.getTime(),
                    proPolicy.updatedAt.getTime(),
                    ...plans.map((plan) => plan.updatedAt.getTime()),
                ),
            ),
            trialDays: settings.trialDays,
            graceDays: settings.graceDays,
            tiers: [this.serializePolicy(freePolicy), this.serializePolicy(proPolicy)],
            plans,
        };
    }

    listPolicies() {
        return this.prisma.entitlementPolicy.findMany({
            orderBy: [{ tier: 'asc' }, { version: 'desc' }],
            include: { _count: { select: { subscriptions: true, trialTenants: true } } },
        });
    }

    getBillingSettings() {
        return this.prisma.billingSettings.upsert({
            where: { id: 'default' },
            update: {},
            create: { id: 'default', trialDays: PROFESSIONAL_TRIAL_DAYS, graceDays: SUBSCRIPTION_GRACE_DAYS },
        });
    }

    updateBillingSettings(trialDays: number, graceDays: number) {
        return this.prisma.billingSettings.upsert({
            where: { id: 'default' },
            update: { trialDays, graceDays },
            create: { id: 'default', trialDays, graceDays },
        });
    }

    async createPolicyDraft(tier: EntitlementTier, name: string, config: EntitlementPolicyConfig) {
        const latest = await this.prisma.entitlementPolicy.aggregate({ where: { tier }, _max: { version: true } });
        return this.prisma.entitlementPolicy.create({
            data: {
                tier,
                version: (latest._max.version ?? 0) + 1,
                name: name.trim(),
                config: config as unknown as Prisma.InputJsonValue,
            },
        });
    }

    async clonePolicyDraft(id: string) {
        const source = await this.prisma.entitlementPolicy.findUnique({ where: { id } });
        if (!source) throw new BadRequestException('权益版本不存在');
        return this.createPolicyDraft(source.tier, `${source.name} 副本`, this.parseConfig(source.config));
    }

    async updatePolicyDraft(id: string, name: string, config: EntitlementPolicyConfig) {
        const existing = await this.prisma.entitlementPolicy.findUnique({ where: { id } });
        if (!existing) throw new BadRequestException('权益版本不存在');
        if (existing.status !== EntitlementPolicyStatus.DRAFT)
            throw new BadRequestException('已发布权益不可直接修改，请复制为新版本');
        return this.prisma.entitlementPolicy.update({
            where: { id },
            data: { name: name.trim(), config: config as unknown as Prisma.InputJsonValue },
        });
    }

    async publishPolicy(id: string) {
        const existing = await this.prisma.entitlementPolicy.findUnique({ where: { id } });
        if (!existing) throw new BadRequestException('权益版本不存在');
        if (existing.status !== EntitlementPolicyStatus.DRAFT) throw new BadRequestException('只有草稿可以发布');
        const now = new Date();
        return this.prisma.$transaction(async (tx) => {
            await tx.entitlementPolicy.updateMany({
                where: { tier: existing.tier, isDefault: true },
                data: { isDefault: false },
            });
            return tx.entitlementPolicy.update({
                where: { id },
                data: { status: EntitlementPolicyStatus.PUBLISHED, isDefault: true, publishedAt: now },
            });
        });
    }

    async retirePolicy(id: string) {
        const existing = await this.prisma.entitlementPolicy.findUnique({ where: { id } });
        if (!existing) throw new BadRequestException('权益版本不存在');
        if (existing.isDefault) throw new BadRequestException('当前默认权益不能停用，请先发布新版本');
        return this.prisma.entitlementPolicy.update({
            where: { id },
            data: { status: EntitlementPolicyStatus.RETIRED, retiredAt: new Date() },
        });
    }

    async getSummary(tenantId: string) {
        const now = new Date();
        const settings = await this.getBillingSettings();
        await this.prisma.tenantSubscription.updateMany({
            where: { tenantId, status: SubscriptionStatus.ACTIVE, expiresAt: { lte: now } },
            data: { status: SubscriptionStatus.EXPIRED },
        });

        const [tenant, activeSubscription, latestExpiredSubscription, paidSubscriptionCount] = await Promise.all([
            this.prisma.tenant.findUnique({
                where: { id: tenantId },
                select: {
                    id: true,
                    trialStartedAt: true,
                    trialEndsAt: true,
                    freeTierResetAt: true,
                    trialEntitlementPolicy: true,
                },
            }),
            this.prisma.tenantSubscription.findFirst({
                where: {
                    tenantId,
                    status: SubscriptionStatus.ACTIVE,
                    startsAt: { lte: now },
                    expiresAt: { gt: now },
                },
                include: { plan: true, entitlementPolicy: true },
                orderBy: { expiresAt: 'desc' },
            }),
            this.prisma.tenantSubscription.findFirst({
                where: {
                    tenantId,
                    status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.EXPIRED] },
                    expiresAt: { lte: now },
                },
                include: { plan: true, entitlementPolicy: true },
                orderBy: { expiresAt: 'desc' },
            }),
            this.prisma.tenantSubscription.count({ where: { tenantId } }),
        ]);

        if (!tenant) throw new BadRequestException('店铺不存在');

        const trialActive = Boolean(tenant.trialStartedAt && tenant.trialEndsAt && tenant.trialEndsAt > now);
        const graceEndsAt = latestExpiredSubscription
            ? new Date(latestExpiredSubscription.expiresAt.getTime() + settings.graceDays * 24 * 60 * 60 * 1000)
            : null;
        const graceActive = Boolean(graceEndsAt && graceEndsAt > now);

        const freePolicy = await this.getDefaultPolicy(EntitlementTier.FREE);
        let policy = freePolicy;
        let state: EntitlementState = 'FREE';
        let entitledUntil: Date | null = null;
        if (activeSubscription) {
            state = 'PAID';
            entitledUntil = activeSubscription.expiresAt;
            policy = activeSubscription.entitlementPolicy;
        } else if (trialActive) {
            state = 'TRIAL';
            entitledUntil = tenant.trialEndsAt;
            policy = tenant.trialEntitlementPolicy ?? (await this.getDefaultPolicy(EntitlementTier.PRO));
        } else if (graceActive) {
            state = 'GRACE';
            entitledUntil = graceEndsAt;
            policy = latestExpiredSubscription!.entitlementPolicy;
        }

        const policyConfig = this.parseConfig(policy.config);
        const freeRecipeLimit = this.parseConfig(freePolicy.config).limits.mainRecipes;
        const freeTierBoundary = latestExpiredSubscription ? graceEndsAt : tenant.trialEndsAt;
        if (
            state === 'FREE' &&
            freeTierBoundary &&
            freeTierBoundary <= now &&
            (!tenant.freeTierResetAt || tenant.freeTierResetAt < freeTierBoundary)
        ) {
            await this.prisma.$transaction([
                this.prisma.recipeFamily.updateMany({
                    where: { tenantId, type: RecipeType.MAIN },
                    data: { freeTierUnlocked: false },
                }),
                this.prisma.tenant.update({
                    where: { id: tenantId },
                    data: { freeTierResetAt: now },
                }),
            ]);
        }

        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const [mainRecipes, monthlyTasks, activeMembers, pendingInvitations, recipeSelection] = await Promise.all([
            this.prisma.recipeFamily.count({
                where: { tenantId, type: RecipeType.MAIN, deletedAt: null },
            }),
            this.prisma.productionTask.count({
                where: { tenantId, deletedAt: null, createdAt: { gte: monthStart } },
            }),
            this.prisma.tenantUser.count({
                where: { tenantId, status: UserStatus.ACTIVE },
            }),
            this.prisma.invitation.count({
                where: { tenantId, status: 'PENDING', expiresAt: { gt: now } },
            }),
            this.prisma.recipeFamily.findMany({
                where: { tenantId, type: RecipeType.MAIN, deletedAt: null },
                select: { id: true, name: true, freeTierUnlocked: true, updatedAt: true },
                orderBy: [{ freeTierUnlocked: 'desc' }, { updatedAt: 'desc' }],
            }),
        ]);

        return {
            state,
            fullAccess: state !== 'FREE',
            active: state === 'PAID',
            entitledUntil,
            current: activeSubscription,
            policy: {
                id: policy.id,
                tier: policy.tier,
                version: policy.version,
                name: policy.name,
                config: policyConfig,
            },
            graceEndsAt: state === 'GRACE' ? graceEndsAt : null,
            trial: {
                eligible: !tenant.trialStartedAt && paidSubscriptionCount === 0,
                startedAt: tenant.trialStartedAt,
                endsAt: tenant.trialEndsAt,
                days: settings.trialDays,
            },
            limits: policyConfig.limits,
            features: policyConfig.features,
            usage: {
                mainRecipes,
                productionTasksThisMonth: monthlyTasks,
                members: activeMembers + pendingInvitations,
            },
            recipeSelection: {
                required: state === 'FREE' && freeRecipeLimit !== null && mainRecipes > freeRecipeLimit,
                recipes: recipeSelection,
            },
        };
    }

    async startTrial(tenantId: string, userId: string, tenantRole: TenantRole) {
        if (tenantRole !== TenantRole.OWNER) throw new ForbiddenException('只有店主可以开启专业版试用');
        const summary = await this.getSummary(tenantId);
        if (!summary.trial.eligible) throw new BadRequestException('该店铺已使用过试用或已有订阅记录');

        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + summary.trial.days * 24 * 60 * 60 * 1000);
        const policy = await this.getDefaultPolicy(EntitlementTier.PRO);
        await this.prisma.tenant.updateMany({
            where: { id: tenantId, members: { some: { userId, role: TenantRole.OWNER } } },
            data: { trialStartedAt: startsAt, trialEndsAt: endsAt, trialEntitlementPolicyId: policy.id },
        });
        return this.getSummary(tenantId);
    }

    async unrestrictFreeRecipe(tenantId: string, tenantRole: TenantRole, recipeId: string) {
        if (tenantRole !== TenantRole.OWNER && tenantRole !== TenantRole.ADMIN) {
            throw new ForbiddenException('您没有管理配方的权限');
        }

        const summary = await this.getSummary(tenantId);
        if (summary.fullAccess) throw new BadRequestException('当前订阅下配方未受限');
        const limit = summary.limits.mainRecipes;

        const remaining = await this.prisma.$transaction(
            async (tx) => {
                const recipe = await tx.recipeFamily.findFirst({
                    where: { id: recipeId, tenantId, type: RecipeType.MAIN, deletedAt: null },
                    select: { id: true, freeTierUnlocked: true },
                });
                if (!recipe) throw new BadRequestException('配方不存在或无法解除受限');

                const enabledCount = await tx.recipeFamily.count({
                    where: { tenantId, type: RecipeType.MAIN, freeTierUnlocked: true },
                });
                if (recipe.freeTierUnlocked) return limit === null ? null : Math.max(limit - enabledCount, 0);
                if (limit !== null && enabledCount >= limit) {
                    throw new BadRequestException(`免费版最多只能启用 ${limit} 个配方`);
                }

                await tx.recipeFamily.update({ where: { id: recipeId }, data: { freeTierUnlocked: true } });
                return limit === null ? null : Math.max(limit - enabledCount - 1, 0);
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        return { remaining };
    }

    async assertCanCreateRecipe(tenantId: string, type: RecipeType = RecipeType.MAIN) {
        if (type !== RecipeType.MAIN) return;
        const summary = await this.getSummary(tenantId);
        const limit = summary.limits.mainRecipes;
        if (summary.fullAccess || limit === null) return;
        const enabledCount = await this.prisma.recipeFamily.count({
            where: { tenantId, type: RecipeType.MAIN, freeTierUnlocked: true },
        });
        if (enabledCount < limit) return;
        this.limitExceeded('RECIPE_LIMIT', `当前权益最多创建 ${limit} 个主配方`);
    }

    async assertRecipeWritable(tenantId: string, familyId: string) {
        const summary = await this.getSummary(tenantId);
        if (summary.fullAccess) return;
        const family = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId, deletedAt: null },
            select: { type: true, freeTierUnlocked: true },
        });
        if (!family) throw new BadRequestException('配方不存在');
        if (family.type !== RecipeType.MAIN || family.freeTierUnlocked) return;
        this.limitExceeded('RECIPE_READ_ONLY', '该配方当前使用受限');
    }

    async assertCanCreateProductionTask(tenantId: string, productIds: string[]) {
        const summary = await this.getSummary(tenantId);
        const limit = summary.limits.productionTasksPerMonth;
        if (limit !== null && summary.usage.productionTasksThisMonth >= limit) {
            this.limitExceeded('TASK_LIMIT', `当前权益每月最多创建 ${limit} 个生产任务`);
        }
        if (summary.fullAccess) return;
        const disabledRecipes = await this.prisma.product.count({
            where: {
                id: { in: productIds },
                recipeVersion: { family: { tenantId, type: RecipeType.MAIN, freeTierUnlocked: false } },
            },
        });
        if (disabledRecipes > 0) this.limitExceeded('RECIPE_READ_ONLY', '生产任务包含使用受限的配方');
    }

    async assertCanInviteMember(tenantId: string) {
        const summary = await this.getSummary(tenantId);
        const limit = summary.limits.members;
        if (limit === null || summary.usage.members < limit) return;
        this.limitExceeded('MEMBER_LIMIT', `当前权益最多包含 ${limit} 名成员`);
    }

    async assertFeature(tenantId: string, feature: EntitlementFeature) {
        const summary = await this.getSummary(tenantId);
        if (summary.features[feature]) return;
        this.limitExceeded('FEATURE_NOT_INCLUDED', '当前权益不包含此功能');
    }

    private limitExceeded(code: string, message: string): never {
        throw new HttpException({ statusCode: 402, code, message, upgradeRequired: true }, 402);
    }

    private async getDefaultPolicy(tier: EntitlementTier) {
        const policy = await this.prisma.entitlementPolicy.findFirst({
            where: { tier, status: EntitlementPolicyStatus.PUBLISHED, isDefault: true },
        });
        if (!policy) throw new HttpException(`未配置 ${tier} 默认权益`, 503);
        return policy;
    }

    private parseConfig(value: Prisma.JsonValue): EntitlementPolicyConfig {
        const config = value as unknown as Partial<EntitlementPolicyConfig>;
        if (!config.limits || !config.features) throw new HttpException('权益配置格式错误', 500);
        return config as EntitlementPolicyConfig;
    }

    private serializePolicy(policy: {
        id: string;
        tier: EntitlementTier;
        version: number;
        name: string;
        config: Prisma.JsonValue;
        updatedAt: Date;
    }) {
        return {
            id: policy.id,
            tier: policy.tier,
            version: policy.version,
            name: policy.name,
            config: this.parseConfig(policy.config),
            updatedAt: policy.updatedAt,
        };
    }
}
