import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
    const adminPhone = process.env.SUPER_ADMIN_PHONE || '13955555555';
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin';

    if (!adminPhone || !adminPassword) {
        throw new Error('SUPER_ADMIN_PHONE and SUPER_ADMIN_PASSWORD must be set in .env');
    }

    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    const admin = await prisma.user.upsert({
        where: { phone: adminPhone }, // 修复：使用 phone 代替 email
        update: {},
        create: {
            name: '超级管理员', // 修复：添加 name 字段
            phone: adminPhone, // 修复：使用 phone 代替 email
            password: hashedPassword, // 修复：使用 password 代替 passwordHash
            role: Role.SUPER_ADMIN, // 修复：使用集成的 Role 枚举
            status: 'ACTIVE',
        },
    });

    console.log(`超级管理员已创建: ${admin.phone}`); // 修复：使用 phone
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => {
        void prisma.$disconnect();
    });
