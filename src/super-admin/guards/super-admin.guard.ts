import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Observable } from 'rxjs';
import { UserPayload } from '../../auth/interfaces/user-payload.interface';
import { Role } from '@prisma/client';
import { Request } from 'express';

@Injectable()
export class SuperAdminGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
        // 修复：为 request 对象添加明确的类型
        const request = context.switchToHttp().getRequest<Request>();
        const user = request.user as UserPayload;
        // 修复：使用 globalRole 进行判断，并确保 user 对象存在
        return !!user && user.globalRole === Role.SUPER_ADMIN;
    }
}
