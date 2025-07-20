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

  @Post()
  create(
    @Body() createIngredientDto: CreateIngredientDto,
    @GetUser() user: UserPayload,
  ) {
    return this.ingredientsService.create(createIngredientDto, user.tenantId);
  }

  // [核心更新] 获取原料列表的端点
  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.ingredientsService.findAllForTenant(user.tenantId);
  }

  @Post(':ingredientId/skus')
  createSku(
    @Param('ingredientId') ingredientId: string,
    @Body() createSkuDto: CreateSkuDto,
  ) {
    return this.ingredientsService.createSku(ingredientId, createSkuDto);
  }

  @Post('procurements')
  createProcurement(@Body() createProcurementDto: CreateProcurementDto) {
    return this.ingredientsService.createProcurement(createProcurementDto);
  }
}
