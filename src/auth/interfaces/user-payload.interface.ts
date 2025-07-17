/**
 * 文件路径: src/auth/interfaces/user-payload.interface.ts
 * 文件描述: 定义了经过JWT守卫验证后，附加到请求对象上的user对象的数据结构。
 */
// (由于文件内容与上一个相似，为简洁起见，实际开发中可以合并，此处分开以保持清晰)
import { Role } from '@prisma/client';

export interface UserPayload {
  userId: string;
  tenantId: string;
  role: Role;
}
