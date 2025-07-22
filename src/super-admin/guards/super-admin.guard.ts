/**
 * 文件路径: src/super-admin/guards/super-admin.guard.ts
 * 文件描述: [新增] 一个自定义守卫，用于验证用户是否为超级管理员。
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { SystemRole } from '@prisma/client';
import { UserPayload } from '../../auth/interfaces/user-payload.interface';
import { Request } from 'express'; // [新增] 导入 Express 的 Request 类型

// [新增] 定义一个带有 user 属性的请求类型接口
interface RequestWithUser extends Request {
  user: UserPayload;
}

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    // [类型修正] 明确 request 的类型，解决 ESLint 报错
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    // 检查JWT payload中是否存在systemRole且其值是否为SUPER_ADMIN
    if (user && user.systemRole === SystemRole.SUPER_ADMIN) {
      return true;
    }

    // 如果不是超级管理员，则抛出禁止访问异常
    throw new ForbiddenException('仅超级管理员可以访问此资源');
  }
}
