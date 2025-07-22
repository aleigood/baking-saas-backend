/**
 * 文件路径: src/recipes/recipes.controller.ts
 * 文件描述: (已更新) 新增了配方版本管理的 API 端点。
 */
import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Param,
  Patch,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RecipesService } from './recipes.service';
import { CreateRecipeFamilyDto } from './dto/create-recipe.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt')) // 对整个控制器的所有路由应用JWT守卫
@Controller('recipes') // 所有路由都以 /recipes 开头
export class RecipesController {
  constructor(private readonly recipesService: RecipesService) {}

  /**
   * 创建一个新配方家族及其首个版本
   * @route POST /recipes
   */
  @Post()
  create(
    @Body() createRecipeFamilyDto: CreateRecipeFamilyDto,
    @GetUser() user: UserPayload,
  ) {
    return this.recipesService.create(createRecipeFamilyDto, user);
  }

  /**
   * 获取当前租户的所有产品列表（仅限激活版本）
   * @route GET /recipes
   */
  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.recipesService.findAll(user);
  }

  /**
   * 获取单个产品的完整详情（仅限激活版本）
   * @route GET /recipes/:id
   */
  @Get(':id')
  findOne(@Param('id') id: string, @GetUser() user: UserPayload) {
    return this.recipesService.findOne(id, user);
  }

  /**
   * [新增] 获取指定配方家族的所有版本列表
   * @route GET /recipes/:familyId/versions
   * @param familyId - 配方家族的ID
   * @param user - 从JWT令牌中解析出的当前用户信息
   */
  @Get(':familyId/versions')
  findAllVersions(
    @Param('familyId') familyId: string,
    @GetUser() user: UserPayload,
  ) {
    return this.recipesService.findAllVersions(familyId, user);
  }

  /**
   * [新增] 激活指定的配方版本
   * @route PATCH /recipes/:familyId/versions/:versionId/activate
   * @param familyId - 配方家族的ID
   * @param versionId - 要激活的配方版本的ID
   * @param user - 从JWT令牌中解析出的当前用户信息
   */
  @Patch(':familyId/versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  activateVersion(
    @Param('familyId') familyId: string,
    @Param('versionId') versionId: string,
    @GetUser() user: UserPayload,
  ) {
    return this.recipesService.activateVersion(familyId, versionId, user);
  }
}
