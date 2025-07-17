/**
 * 文件路径: src/app.controller.ts
 * 文件描述: 应用的根控制器，用于演示如何使用JWT守卫保护路由。
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from './auth/decorators/get-user.decorator';
import { UserPayload } from './auth/interfaces/user-payload.interface';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * 获取用户个人资料的受保护路由。
   * @decorator @UseGuards(AuthGuard('jwt')) - 应用JWT守卫，只有携带有效令牌的请求才能访问。
   * @decorator @GetUser() - 使用自定义装饰器，方便地获取已验证的用户信息。
   * @param user - 经过守卫验证后，附加到请求上的用户信息对象。
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('profile')
  getProfile(@GetUser() user: UserPayload) {
    return this.appService.getProfile(user);
  }
}
