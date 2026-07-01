import { EntitlementPolicyStatus, EntitlementTier, GlobalRole, PrismaClient, TenantRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const isProduction = process.env.NODE_ENV === 'production';

function requireEnv(name: string) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`生产环境必须配置 ${name}`);
    }
    return value;
}

async function main() {
    console.log('开始执行种子脚本...');

    const adminPhone = isProduction ? requireEnv('SUPER_ADMIN_PHONE') : process.env.SUPER_ADMIN_PHONE || '13888888888';
    const adminPassword = isProduction
        ? requireEnv('SUPER_ADMIN_PASSWORD')
        : process.env.SUPER_ADMIN_PASSWORD || 'Hoston0859';
    const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.upsert({
        where: { phone: adminPhone },
        update: {
            name: '超级管理员',
            phoneVerifiedAt: new Date(),
            profileCompletedAt: new Date(),
            globalRole: GlobalRole.SUPER_ADMIN,
            status: 'ACTIVE',
        },
        create: {
            name: '超级管理员',
            phone: adminPhone,
            phoneVerifiedAt: new Date(),
            profileCompletedAt: new Date(),
            password: hashedAdminPassword,
            globalRole: GlobalRole.SUPER_ADMIN,
            status: 'ACTIVE',
        },
    });
    console.log(`超级管理员已创建/确认存在: ${adminPhone}`);

    await seedEntitlementPolicies();
    await seedSubscriptionPlans();

    if (isProduction) {
        console.log('生产环境跳过演示用户和演示店铺。');
        console.log('种子脚本执行完毕！');
        return;
    }

    // 仅开发环境创建演示用店主账户
    const leoPhone = '13951958163';
    const leoPassword = 'Hulei1234';
    const hashedLeoPassword = await bcrypt.hash(leoPassword, 10);

    const leo = await prisma.user.upsert({
        where: { phone: leoPhone },
        update: { phoneVerifiedAt: new Date(), profileCompletedAt: new Date(), wechatNickname: 'Leo' },
        create: {
            name: 'Leo',
            wechatNickname: 'Leo',
            phone: leoPhone,
            phoneVerifiedAt: new Date(),
            profileCompletedAt: new Date(),
            password: hashedLeoPassword,
            globalRole: GlobalRole.USER,
            status: 'ACTIVE',
        },
    });
    console.log(`测试店主 "Leo" 已创建/确认存在: ${leoPhone}`);

    const existingDemoTenant = await prisma.tenant.findFirst({
        where: {
            name: '小时光',
            members: {
                some: {
                    userId: leo.id,
                    role: TenantRole.OWNER,
                },
            },
        },
    });

    if (!existingDemoTenant) {
        await prisma.tenant.create({
            data: {
                name: '小时光',
                address: '测试地址',
                members: {
                    create: {
                        userId: leo.id,
                        role: TenantRole.OWNER,
                        status: 'ACTIVE',
                    },
                },
            },
        });
        console.log(`店铺 "小时光" 已创建，并关联到用户 "Leo"`);
    } else {
        console.log(`店铺 "小时光" 已确认存在，并关联到用户 "Leo"`);
    }

    console.log('种子脚本执行完毕！');
}

async function seedSubscriptionPlans() {
    const plans = [
        {
            code: 'monthly',
            name: '1个月',
            durationDays: 31,
            priceInCents: 3900,
            originalPriceInCents: null,
            sortOrder: 1,
        },
        {
            code: 'quarterly',
            name: '3个月',
            durationDays: 93,
            priceInCents: 9900,
            originalPriceInCents: 11700,
            sortOrder: 2,
        },
        {
            code: 'half_year',
            name: '6个月',
            durationDays: 186,
            priceInCents: 17900,
            originalPriceInCents: 23400,
            sortOrder: 3,
        },
        {
            code: 'yearly',
            name: '1年',
            durationDays: 366,
            priceInCents: 29900,
            originalPriceInCents: 46800,
            sortOrder: 4,
        },
    ];

    for (const plan of plans) {
        await prisma.subscriptionPlan.upsert({
            where: { code: plan.code },
            update: {
                name: plan.name,
                durationDays: plan.durationDays,
                priceInCents: plan.priceInCents,
                originalPriceInCents: plan.originalPriceInCents,
                sortOrder: plan.sortOrder,
            },
            create: {
                ...plan,
                isActive: true,
            },
        });
    }

    console.log('订阅套餐已创建/确认存在。');
}

async function seedEntitlementPolicies() {
    await prisma.billingSettings.upsert({
        where: { id: 'default' },
        update: {},
        create: { id: 'default', trialDays: 14, graceDays: 7 },
    });
    const policies = [
        {
            id: '00000000-0000-4000-8000-00000000f001',
            tier: EntitlementTier.FREE,
            name: '免费版权益 V1',
            config: {
                limits: { mainRecipes: 3, productionTasksPerMonth: 10, members: 2 },
                features: { costing: true, statistics: true, batchImport: true, export: true },
            },
        },
        {
            id: '00000000-0000-4000-8000-00000000f002',
            tier: EntitlementTier.PRO,
            name: '专业版权益 V1',
            config: {
                limits: { mainRecipes: null, productionTasksPerMonth: null, members: null },
                features: { costing: true, statistics: true, batchImport: true, export: true },
            },
        },
    ];
    for (const policy of policies) {
        await prisma.entitlementPolicy.upsert({
            where: { id: policy.id },
            update: {},
            create: {
                ...policy,
                version: 1,
                status: EntitlementPolicyStatus.PUBLISHED,
                isDefault: true,
                publishedAt: new Date(),
            },
        });
    }
    console.log('默认权益版本已创建/确认存在。');
}

main()
    .catch((e) => {
        console.error('种子脚本执行失败:', e);
        process.exit(1);
    })
    .finally(() => {
        void prisma.$disconnect();
    });
