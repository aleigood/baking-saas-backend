import { Controller, Get, UseGuards, Param } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Tenant } from '@prisma/client';
import {
  ProductionTaskDto,
  RecipeDto,
  IngredientDto,
  MemberDto,
  RecipeStatDto,
  IngredientStatDto,
} from './dto/tenant-data.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  /**
   * GET /tenants
   * 获取当前用户所属的店铺列表
   */
  @Get()
  findUserTenants(@GetUser() user: UserPayload): Promise<Tenant[]> {
    return this.tenantsService.findForUser(user);
  }

  /**
   * GET /tenants/:tenantId/production
   * 获取指定店铺的制作任务列表
   */
  @Get(':tenantId/production')
  findProductionTasks(
    @Param('tenantId') tenantId: string,
  ): Promise<ProductionTaskDto[]> {
    return this.tenantsService.findProductionTasks(tenantId);
  }

  /**
   * GET /tenants/:tenantId/recipes
   * 获取指定店铺的配方/产品列表
   */
  @Get(':tenantId/recipes')
  findRecipes(@Param('tenantId') tenantId: string): Promise<RecipeDto[]> {
    return this.tenantsService.findRecipes(tenantId);
  }

  /**
   * GET /tenants/:tenantId/ingredients
   * 获取指定店铺的原料列表
   */
  @Get(':tenantId/ingredients')
  findIngredients(
    @Param('tenantId') tenantId: string,
  ): Promise<IngredientDto[]> {
    return this.tenantsService.findIngredients(tenantId);
  }

  /**
   * GET /tenants/:tenantId/members
   * 获取指定店铺的人员列表
   */
  @Get(':tenantId/members')
  findMembers(@Param('tenantId') tenantId: string): Promise<MemberDto[]> {
    return this.tenantsService.findMembers(tenantId);
  }

  /**
   * GET /tenants/:tenantId/stats/recipes
   * 获取指定店铺的配方统计数据
   */
  @Get(':tenantId/stats/recipes')
  findRecipeStats(
    @Param('tenantId') tenantId: string,
  ): Promise<RecipeStatDto[]> {
    return this.tenantsService.findRecipeStats(tenantId);
  }

  /**
   * GET /tenants/:tenantId/stats/ingredients
   * 获取指定店铺的原料统计数据
   */
  @Get(':tenantId/stats/ingredients')
  findIngredientStats(
    @Param('tenantId') tenantId: string,
  ): Promise<IngredientStatDto[]> {
    return this.tenantsService.findIngredientStats(tenantId);
  }
}
