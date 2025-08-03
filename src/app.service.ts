/**
 * 文件路径: src/app.service.ts
 * 文件描述: 应用的根服务，提供业务逻辑方法。
 */
import { Injectable } from '@nestjs/common';
import { UserPayload } from './auth/interfaces/user-payload.interface';

@Injectable()
export class AppService {
  getHello(): string {
    return '欢迎来到烘焙SaaS平台后端服务! (Welcome to Baking SaaS Backend Service!)';
  }

  /**
   * [修改]
   * 根据用户信息返回欢迎信息
   * @param user - 从JWT令牌中解析出的用户信息
   * @returns 欢迎字符串
   */
  getProfile(user: UserPayload): string {
    // 修复：JWT payload中的用户ID是 'sub'
    return `欢迎回来！您的用户ID是 ${user.sub}，您当前正在管理的门店ID是 ${user.tenantId}，您的角色是 ${user.role}。`;
  }
}
