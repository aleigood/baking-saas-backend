/**
 * 文件路径: src/recipes/recipes.controller.ts
 * 文件描述: 接收配方相关的HTTP请求，并调用服务处理。
 */
import { Controller, Get, Post, Body, UseGuards, Param } from '@nestjs/common';
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
   * 创建新配方的端点
   * @route POST /recipes
   * @param createRecipeFamilyDto - 从请求体中获取的配方数据
   * @param user - 从JWT令牌中解析出的当前用户信息
   */
  @Post()
  create(
    @Body() createRecipeFamilyDto: CreateRecipeFamilyDto,
    @GetUser() user: UserPayload,
  ) {
    return this.recipesService.create(createRecipeFamilyDto, user);
  }

  /**
   * 获取当前租户的所有配方列表的端点
   * @route GET /recipes
   * @param user - 从JWT令牌中解析出的当前用户信息
   */
  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.recipesService.findAll(user);
  }

  /**
   * 获取单个配方完整详情的端点
   * @route GET /recipes/:id
   * @param id - 从URL路径中提取的配方ID
   * @param user - 从JWT令牌中解析出的当前用户信息
   */
  @Get(':id')
  findOne(@Param('id') id: string, @GetUser() user: UserPayload) {
    return this.recipesService.findOne(id, user);
  }
}
