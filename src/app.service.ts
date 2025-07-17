/**
 * 文件路径: src/app.service.ts
 * 文件描述: 应用的根服务，提供业务逻辑方法。
 */
import { Injectable } from '@nestjs/common';
import { UserPayload } from './auth/interfaces/user-payload.interface';

@Injectable()
export class AppService {
  /**
   * 提供一个公开的欢迎信息。
   */
  getHello(): string {
    return '欢迎来到烘焙SaaS平台后端服务! (Welcome to Baking SaaS Backend Service!)';
  }

  /**
   * 处理受保护的路由逻辑，返回包含用户身份信息的欢迎语。
   * @param user - 类型安全的用户信息对象。
   */
  getProfile(user: UserPayload) {
    return `欢迎回来！您的用户ID是 ${user.userId}，您当前正在管理的门店ID是 ${user.tenantId}，您的角色是 ${user.role}。`;
  }
}
