/**
 * 文件路径: src/super-admin/super-admin.controller.ts
 * 文件描述: [修改] 新增创建独立用户的端点，并调整创建店铺的流程。
 */
import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Param,
  Patch,
  Delete,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { CreateOwnerDto } from './dto/create-owner.dto';
import { AuthGuard } from '@nestjs/passport';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CreateRecipeFamilyDto } from '../recipes/dto/create-recipe.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { PaginationQueryDto } from './dto/query.dto';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';
// [新增] 导入 CreateUserDto
import { CreateUserDto } from './dto/create-user.dto';

// 使用两个守卫：首先验证JWT令牌有效性，然后验证是否为超级管理员
@UseGuards(AuthGuard('jwt'), SuperAdminGuard)
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  /**
   * [新增] 获取仪表盘统计数据的API端点
   * @route GET /super-admin/stats
   */
  @Get('stats')
  getDashboardStats() {
    return this.superAdminService.getDashboardStats();
  }

  /**
   * [修改] 创建新店铺并关联老板的API端点
   * @route POST /super-admin/tenants
   */
  @Post('tenants')
  createTenant(@Body() createTenantDto: CreateTenantDto) {
    return this.superAdminService.createTenant(createTenantDto);
  }

  /**
   * [新增] 更新店铺信息的API端点
   * @route PATCH /super-admin/tenants/:id
   */
  @Patch('tenants/:id')
  updateTenant(
    @Param('id') id: string,
    @Body() updateTenantDto: UpdateTenantDto,
  ) {
    return this.superAdminService.updateTenant(id, updateTenantDto);
  }

  /**
   * [新增] 停用店铺（软删除）的API端点
   * @route DELETE /super-admin/tenants/:id
   */
  @Delete('tenants/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivateTenant(@Param('id') id: string) {
    return this.superAdminService.deactivateTenant(id);
  }

  /**
   * [新增] 重新激活店铺的API端点
   * @route PATCH /super-admin/tenants/:id/reactivate
   */
  @Patch('tenants/:id/reactivate')
  reactivateTenant(@Param('id') id: string) {
    return this.superAdminService.reactivateTenant(id);
  }

  /**
   * [修改] 获取所有店铺列表的API端点，支持查询参数
   * @route GET /super-admin/tenants
   */
  @Get('tenants')
  findAllTenants(@Query() queryDto: PaginationQueryDto) {
    return this.superAdminService.findAllTenants(queryDto);
  }

  /**
   * [新增] 创建一个独立的用户账号（不立即关联店铺）
   * @route POST /super-admin/users
   */
  @Post('users')
  createUser(@Body() createUserDto: CreateUserDto) {
    return this.superAdminService.createUser(createUserDto);
  }

  /**
   * [废弃] 此端点逻辑已合并到创建店铺流程中，或由新的工作流替代
   * @deprecated
   * @route POST /super-admin/users/owner
   */
  @Post('users/owner')
  createOwner(@Body() createOwnerDto: CreateOwnerDto) {
    return this.superAdminService.createOwner(createOwnerDto);
  }

  /**
   * [修改] 获取所有用户列表的API端点，支持查询参数
   * @route GET /super-admin/users
   */
  @Get('users')
  findAllUsers(@Query() queryDto: PaginationQueryDto) {
    return this.superAdminService.findAllUsers(queryDto);
  }

  /**
   * [修改] 更新用户信息的API端点，增加 currentUser 传递
   * @route PATCH /super-admin/users/:id
   */
  @Patch('users/:id')
  updateUser(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @GetUser() currentUser: UserPayload, // [新增] 获取当前用户信息
  ) {
    return this.superAdminService.updateUser(id, updateUserDto, currentUser);
  }

  /**
   * [新增] 更新用户状态的API端点
   * @route PATCH /super-admin/users/:id/status
   */
  @Patch('users/:id/status')
  updateUserStatus(
    @Param('id') id: string,
    @Body() updateUserStatusDto: UpdateUserStatusDto,
    @GetUser() currentUser: UserPayload,
  ) {
    return this.superAdminService.updateUserStatus(
      id,
      updateUserStatusDto.status,
      currentUser,
    );
  }

  /**
   * [新增] 获取配方导入模板的API端点
   * @route GET /super-admin/recipes/template
   */
  @Get('recipes/template')
  getRecipeTemplate() {
    return this.superAdminService.getRecipeTemplateJson();
  }

  /**
   * [新增] 为指定店铺导入配方的API端点
   * @route POST /super-admin/tenants/:tenantId/recipes/import
   */
  @Post('tenants/:tenantId/recipes/import')
  importRecipe(
    @Param('tenantId') tenantId: string,
    @Body() recipeDto: CreateRecipeFamilyDto,
  ) {
    return this.superAdminService.importRecipe(tenantId, recipeDto);
  }
}
