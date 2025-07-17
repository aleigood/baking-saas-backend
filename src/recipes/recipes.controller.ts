/**
 * 文件路径: src/recipes/recipes.controller.ts
 * 文件描述: 接收配方相关的HTTP请求，并调用服务处理。
 */
import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
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
   * 获取所有配方的端点
   * @param user - 从JWT令牌中解析出的当前用户信息
   */
  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.recipesService.findAll(user);
  }
}
