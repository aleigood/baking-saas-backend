import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, ParseUUIDPipe } from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';
import { AuthGuard } from '@nestjs/passport';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { QueryDto } from './dto/query.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
// [G-Code-Note] [核心修改] 导入 CreateRecipeDto 和 BatchImportRecipeDto
import { CreateRecipeDto } from '../recipes/dto/create-recipe.dto';
import { BatchImportRecipeDto } from '../recipes/dto/batch-import-recipe.dto'; // [G-Code-Note] 确保这个 DTO 路径正确
import { UpdateTenantStatusDto } from './dto/update-tenant-status.dto';
import { UpdateUserStatusDto } from './dto/update-user-status.dto';

@UseGuards(AuthGuard('jwt'), SuperAdminGuard)
@Controller('super-admin')
export class SuperAdminController {
    constructor(private readonly superAdminService: SuperAdminService) {}

    @Get('dashboard-stats')
    getDashboardStats() {
        return this.superAdminService.getDashboardStats();
    }

    // --- Tenant endpoints ---
    @Get('tenants')
    findAllTenants(@Query() queryDto: QueryDto) {
        return this.superAdminService.findAllTenants(queryDto);
    }

    @Post('tenants')
    createTenant(@Body() createTenantDto: CreateTenantDto) {
        return this.superAdminService.createTenant(createTenantDto);
    }

    @Patch('tenants/:id')
    updateTenant(@Param('id', ParseUUIDPipe) id: string, @Body() updateTenantDto: UpdateTenantDto) {
        return this.superAdminService.updateTenant(id, updateTenantDto);
    }

    @Patch('tenants/:id/status')
    updateTenantStatus(@Param('id', ParseUUIDPipe) id: string, @Body() updateTenantStatusDto: UpdateTenantStatusDto) {
        return this.superAdminService.updateTenantStatus(id, updateTenantStatusDto);
    }

    @Delete('tenants/:id')
    deleteTenant(@Param('id', ParseUUIDPipe) id: string) {
        return this.superAdminService.deleteTenant(id);
    }

    // --- User endpoints ---
    @Get('users')
    findAllUsers(@Query() queryDto: QueryDto) {
        return this.superAdminService.findAllUsers(queryDto);
    }

    @Post('users')
    createUser(@Body() createUserDto: CreateUserDto) {
        return this.superAdminService.createUser(createUserDto);
    }

    @Patch('users/:id')
    updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() updateUserDto: UpdateUserDto) {
        return this.superAdminService.updateUser(id, updateUserDto);
    }

    @Patch('users/:id/status')
    updateUserStatus(@Param('id', ParseUUIDPipe) id: string, @Body() updateUserStatusDto: UpdateUserStatusDto) {
        return this.superAdminService.updateUserStatus(id, updateUserStatusDto);
    }

    @Delete('users/:id')
    deleteUser(@Param('id', ParseUUIDPipe) id: string) {
        return this.superAdminService.deleteUser(id);
    }

    // --- Recipe endpoints ---

    /**
     * 为指定租户创建【单个】配方
     */
    @Post('tenants/:tenantId/recipes')
    createRecipeForTenant(
        @Param('tenantId', ParseUUIDPipe) tenantId: string,
        @Body() createRecipeDto: CreateRecipeDto, // [G-Code-Note] 接收一个对象 {}
    ) {
        return this.superAdminService.createRecipeForTenant(tenantId, createRecipeDto);
    }

    /**
     * [G-Code-Note] [核心新增] 为指定租户【批量导入】配方
     */
    @Post('tenants/:tenantId/recipes/batch-import')
    batchImportRecipesForTenant(
        @Param('tenantId', ParseUUIDPipe) tenantId: string,
        @Body() batchImportRecipesDto: BatchImportRecipeDto[], // [G-Code-Note] 接收一个数组 []
    ) {
        return this.superAdminService.batchImportRecipesForTenant(tenantId, batchImportRecipesDto);
    }
}
