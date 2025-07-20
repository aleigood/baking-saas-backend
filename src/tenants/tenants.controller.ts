import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { AuthGuard } from '@nestjs/passport'; // [修复] 引入正确的 AuthGuard
import { GetUser } from '../auth/decorators/get-user.decorator'; // [修复] 引入 GetUser 装饰器
import { UserPayload } from '../auth/interfaces/user-payload.interface'; // [修复] 引入 UserPayload 接口

@UseGuards(AuthGuard('jwt')) // [修复] 对整个控制器应用正确的JWT守卫
@Controller('tenants') // 所有此控制器的路由都以 /tenants 开头
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  /**
   * 定义 GET /tenants 接口
   */
  @Get()
  findUserTenants(@GetUser() user: UserPayload) {
    // [修复] 使用 @GetUser 装饰器直接获取用户信息
    return this.tenantsService.findForUser(user);
  }
}
