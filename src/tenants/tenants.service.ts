import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  /**
   * 根据用户ID查找该用户所属的所有店铺
   * @param user - 从JWT令牌中解析出的用户信息载荷
   * @returns 返回一个包含该用户所有店铺信息的数组
   */
  async findForUser(user: UserPayload) {
    // 这是 Prisma 的核心查询逻辑：
    // 我们在 Tenant (店铺) 表中进行查询，
    // 查询条件是，该店铺所关联的用户列表 (users) 中，
    // 至少有一个 (some) 用户的 userId 匹配我们传入的参数。
    // 这正是利用了 TenantUser 这个中间表来实现的。
    const tenants = await this.prisma.tenant.findMany({
      where: {
        users: {
          some: {
            // [修复] 将 user.sub 修改为 user.userId 以匹配 UserPayload 接口
            userId: user.userId,
          },
        },
      },
    });
    return tenants;
  }
}
