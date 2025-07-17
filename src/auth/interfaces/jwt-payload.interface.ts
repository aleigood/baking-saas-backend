/**
 * 文件路径: src/auth/interfaces/jwt-payload.interface.ts
 * 文件描述: 定义了我们签发到JWT令牌中的数据结构。
 */
import { Role } from '@prisma/client';

export interface JwtPayload {
  sub: string; // 用户ID
  tenantId: string; // 租户ID
  role: Role; // 角色
}
