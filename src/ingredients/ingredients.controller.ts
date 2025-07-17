/**
 * 文件路径: src/ingredients/ingredients.controller.ts
 * 文件描述: 接收原料相关的HTTP请求，并调用服务处理。
 */
import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { IngredientsService } from './ingredients.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('ingredients')
export class IngredientsController {
  constructor(private readonly ingredientsService: IngredientsService) {}

  /**
   * 创建新原料品类的端点
   * @route POST /ingredients
   */
  @Post()
  createIngredient(
    @Body() createIngredientDto: CreateIngredientDto,
    @GetUser() user: UserPayload,
  ) {
    return this.ingredientsService.createIngredient(createIngredientDto, user);
  }

  /**
   * 为原料品类添加新SKU的端点
   * @route POST /ingredients/:ingredientId/skus
   */
  @Post(':ingredientId/skus')
  createSku(
    @Param('ingredientId') ingredientId: string,
    @Body() createSkuDto: CreateSkuDto,
    @GetUser() user: UserPayload,
  ) {
    return this.ingredientsService.createSku(ingredientId, createSkuDto, user);
  }

  /**
   * 为SKU添加入库记录的端点
   * @route POST /skus/:skuId/procurements
   */
  @Post('/skus/:skuId/procurements')
  createProcurement(
    @Param('skuId') skuId: string,
    @Body() createProcurementDto: CreateProcurementDto,
    @GetUser() user: UserPayload,
  ) {
    return this.ingredientsService.createProcurement(
      skuId,
      createProcurementDto,
      user,
    );
  }

  /**
   * 获取所有原料品类及其总库存的端点
   * @route GET /ingredients
   */
  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.ingredientsService.findAll(user);
  }
}
