/**
 * 文件路径: src/ingredients/ingredients.controller.ts
 * 文件描述: (已更新) 增加了更新原料和设置默认SKU的API端点。
 */
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Patch,
} from '@nestjs/common';
import { IngredientsService } from './ingredients.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { SetDefaultSkuDto } from './dto/set-default-sku.dto';

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

  /**
   * [新增] 更新原料信息（如含水率）
   * @route PATCH /ingredients/:id
   */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateIngredientDto: UpdateIngredientDto,
    @GetUser() user: UserPayload,
  ) {
    return this.ingredientsService.update(id, updateIngredientDto, user);
  }

  /**
   * [新增] 设置原料的默认SKU
   * @route PATCH /ingredients/:id/default-sku
   */
  @Patch(':id/default-sku')
  setDefaultSku(
    @Param('id') id: string,
    @Body() setDefaultSkuDto: SetDefaultSkuDto,
    @GetUser() user: UserPayload,
  ) {
    return this.ingredientsService.setDefaultSku(
      id,
      setDefaultSkuDto.skuId,
      user,
    );
  }
}
