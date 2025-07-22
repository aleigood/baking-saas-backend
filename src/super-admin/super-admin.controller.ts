/**
 * 文件路径: src/super-admin/super-admin.controller.ts
 * 文件描述: [新增] 处理所有与超级管理后台相关的API请求。
 */
import { Controller, Post, Body, UseGuards, Get } from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { CreateOwnerDto } from './dto/create-owner.dto';
import { AuthGuard } from '@nestjs/passport';

// 使用两个守卫：首先验证JWT令牌有效性，然后验证是否为超级管理员
@UseGuards(AuthGuard('jwt'), SuperAdminGuard)
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  /**
   * [新增] 创建新店铺的API端点
   * @route POST /super-admin/tenants
   */
  @Post('tenants')
  createTenant(@Body() createTenantDto: CreateTenantDto) {
    return this.superAdminService.createTenant(createTenantDto);
  }

  /**
   * [新增] 创建新老板账号并关联到店铺的API端点
   * @route POST /super-admin/users/owner
   */
  @Post('users/owner')
  createOwner(@Body() createOwnerDto: CreateOwnerDto) {
    return this.superAdminService.createOwner(createOwnerDto);
  }

  /**
   * [新增] 获取所有店铺列表的API端点
   * @route GET /super-admin/tenants
   */
  @Get('tenants')
  findAllTenants() {
    return this.superAdminService.findAllTenants();
  }
}
