import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { SuperAdminService } from './super-admin.service';
import { AuthGuard } from '@nestjs/passport';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { QueryDto } from './dto/query.dto';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateRecipeDto } from '../recipes/dto/create-recipe.dto';

@UseGuards(AuthGuard('jwt'), SuperAdminGuard)
@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly superAdminService: SuperAdminService) {}

  @Get('dashboard-stats')
  getDashboardStats() {
    return this.superAdminService.getDashboardStats();
  }

  // Tenant endpoints
  @Get('tenants')
  findAllTenants(@Query() queryDto: QueryDto) {
    return this.superAdminService.findAllTenants(queryDto);
  }

  @Post('tenants')
  createTenant(@Body() createTenantDto: CreateTenantDto) {
    return this.superAdminService.createTenant(createTenantDto);
  }

  @Patch('tenants/:id')
  updateTenant(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateTenantDto: UpdateTenantDto,
  ) {
    return this.superAdminService.updateTenant(id, updateTenantDto);
  }

  @Delete('tenants/:id')
  deleteTenant(@Param('id', ParseUUIDPipe) id: string) {
    return this.superAdminService.deleteTenant(id);
  }

  // User endpoints
  @Get('users')
  findAllUsers(@Query() queryDto: QueryDto) {
    return this.superAdminService.findAllUsers(queryDto);
  }

  @Post('users')
  createUser(@Body() createUserDto: CreateUserDto) {
    return this.superAdminService.createUser(createUserDto);
  }

  @Patch('users/:id')
  updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.superAdminService.updateUser(id, updateUserDto);
  }

  @Delete('users/:id')
  deleteUser(@Param('id', ParseUUIDPipe) id: string) {
    return this.superAdminService.deleteUser(id);
  }

  // Recipe endpoints
  @Post('tenants/:tenantId/recipes')
  createRecipeForTenant(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Body() createRecipeDto: CreateRecipeDto,
  ) {
    return this.superAdminService.createRecipeForTenant(
      tenantId,
      createRecipeDto,
    );
  }
}
