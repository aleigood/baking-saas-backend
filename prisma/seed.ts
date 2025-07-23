// prisma/seed.ts
import { PrismaClient, SystemRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log(`开始植入种子数据...`);

  const adminEmail = 'admin@example.com';
  const adminPassword = 'supersecretpassword'; // 请务必在生产环境中更换为更复杂的密码

  // 使用 upsert 避免重复创建
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: 'Super Admin',
      passwordHash: await bcrypt.hash(adminPassword, 10),
      systemRole: SystemRole.SUPER_ADMIN,
    },
  });

  console.log(`超级管理员已创建: ${admin.email}`);
  console.log(`种子数据植入完成。`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
