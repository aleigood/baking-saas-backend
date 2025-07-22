/**
 * 文件路径: src/auth/interfaces/user-payload.interface.ts
 * 文件描述: 定义了经过JWT守卫验证后，附加到请求对象上的user对象的数据结构。
 */
import { Role, SystemRole } from '@prisma/client'; // [修改] 导入 SystemRole

export interface UserPayload {
  userId: string;
  tenantId: string;
  role: Role;
  systemRole?: SystemRole; // [新增] 系统级角色
}
