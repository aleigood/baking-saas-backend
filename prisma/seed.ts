import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    console.log('开始执行种子脚本...');

    // 1. 创建超级管理员
    const adminPhone = process.env.SUPER_ADMIN_PHONE || '13955555555';
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin';
    const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.upsert({
        where: { phone: adminPhone },
        update: {},
        create: {
            name: '超级管理员',
            phone: adminPhone,
            password: hashedAdminPassword,
            role: Role.SUPER_ADMIN,
            status: 'ACTIVE',
        },
    });
    console.log(`超级管理员已创建/确认存在: ${adminPhone}`);

    // 2. 创建一个测试用的店主（Owner）账户
    const leoPhone = '13966666666';
    const leoPassword = '123';
    const hashedLeoPassword = await bcrypt.hash(leoPassword, 10);

    await prisma.user.upsert({
        where: { phone: leoPhone },
        update: {},
        create: {
            name: 'Leo',
            phone: leoPhone,
            password: hashedLeoPassword,
            role: Role.OWNER, // 角色为店主
            status: 'ACTIVE',
        },
    });
    console.log(`测试店主 "Leo" 已创建/确认存在: ${leoPhone}`);

    console.log('种子脚本执行完毕！');
}

main()
    .catch((e) => {
        console.error('种子脚本执行失败:', e);
        process.exit(1);
    })
    .finally(() => {
        void prisma.$disconnect();
    });
