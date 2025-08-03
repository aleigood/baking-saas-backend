import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
  Query,
  NotFoundException,
} from '@nestjs/common';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('recipes')
export class RecipesController {
  constructor(private readonly recipesService: RecipesService) {}

  /**
   * 导入或创建一个新配方。
   * 如果是已存在的配方，则会创建一个新版本。
   */
  @Post()
  create(
    @GetUser() user: UserPayload,
    @Body() createRecipeDto: CreateRecipeDto,
  ) {
    // 从JWT token中获取tenantId
    const tenantId = user.tenantId;
    return this.recipesService.create(tenantId, createRecipeDto);
  }

  /**
   * 获取当前租户的所有配方族（及其激活版本）。
   */
  @Get()
  findAll(@GetUser() user: UserPayload) {
    const tenantId = user.tenantId;
    return this.recipesService.findAll(tenantId);
  }

  /**
   * 根据配方族ID获取配方的详细信息。
   * @param id 配方族ID
   * @param version 可选查询参数，用于获取特定版本，不提供则返回激活版本
   */
  @Get(':id')
  async findOne(@Param('id') id: string, @Query('version') version?: string) {
    const versionNumber = version ? parseInt(version, 10) : undefined;
    const recipe = await this.recipesService.findOne(id, versionNumber);
    if (!recipe || recipe.versions.length === 0) {
      throw new NotFoundException(
        `ID为 ${id} 且版本为 ${version || '激活'} 的配方未找到`,
      );
    }
    return recipe;
  }

  /**
   * 软删除一个配方族。
   * @param id 配方族ID
   */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.recipesService.remove(id);
  }
}
