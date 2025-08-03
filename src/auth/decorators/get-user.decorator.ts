/**
 * 文件路径: src/auth/decorators/get-user.decorator.ts
 * 文件描述:
 * 这是一个自定义参数装饰器，用于从请求对象中安全地提取用户信息。
 * 它使得在控制器中获取user对象变得简洁且类型安全。
 */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserPayload } from '../interfaces/user-payload.interface';
import { Request } from 'express'; // 导入Express的Request类型

export const GetUser = createParamDecorator((data: unknown, ctx: ExecutionContext): UserPayload => {
    // 为 getRequest() 返回的对象提供了明确的类型。
    // 我们告诉TypeScript，这个request对象上会有一个user属性，且其类型为UserPayload。
    const request: Request & { user: UserPayload } = ctx.switchToHttp().getRequest();
    return request.user;
});
