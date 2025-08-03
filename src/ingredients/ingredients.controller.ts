import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { IngredientsService } from './ingredients.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { UserPayload } from 'src/auth/interfaces/user-payload.interface';
// [FIX] 修复守卫的使用方式，与项目中其他控制器保持一致
import { AuthGuard } from '@nestjs/passport';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';

// [FIX] 使用 NestJS 内置的 AuthGuard('jwt')，而不是不存在的自定义 JwtAuthGuard
@UseGuards(AuthGuard('jwt'))
@Controller('ingredients')
export class IngredientsController {
  constructor(private readonly ingredientsService: IngredientsService) {}

  @Post()
  create(
    @GetUser() user: UserPayload,
    @Body() createIngredientDto: CreateIngredientDto,
  ) {
    return this.ingredientsService.create(user.tenantId, createIngredientDto);
  }

  @Get()
  findAll(@GetUser() user: UserPayload) {
    return this.ingredientsService.findAll(user.tenantId);
  }

  @Get(':id')
  findOne(@GetUser() user: UserPayload, @Param('id') id: string) {
    return this.ingredientsService.findOne(user.tenantId, id);
  }

  @Patch(':id')
  update(
    @GetUser() user: UserPayload,
    @Param('id') id: string,
    @Body() updateIngredientDto: UpdateIngredientDto,
  ) {
    return this.ingredientsService.update(
      user.tenantId,
      id,
      updateIngredientDto,
    );
  }

  @Delete(':id')
  remove(@GetUser() user: UserPayload, @Param('id') id: string) {
    return this.ingredientsService.remove(user.tenantId, id);
  }

  @Post(':ingredientId/skus')
  createSku(
    @GetUser() user: UserPayload,
    @Param('ingredientId') ingredientId: string,
    @Body() createSkuDto: CreateSkuDto,
  ) {
    return this.ingredientsService.createSku(
      user.tenantId,
      ingredientId,
      createSkuDto,
    );
  }

  /**
   * [V2.1 接口变更] 设置激活的SKU
   */
  @Post(':ingredientId/active-sku')
  setActiveSku(
    @GetUser() user: UserPayload,
    @Param('ingredientId') ingredientId: string,
    @Body() setActiveSkuDto: SetActiveSkuDto,
  ) {
    return this.ingredientsService.setActiveSku(
      user.tenantId,
      ingredientId,
      setActiveSkuDto,
    );
  }

  @Post('skus/:skuId/procurements')
  createProcurement(
    @GetUser() user: UserPayload,
    @Param('skuId') skuId: string,
    @Body() createProcurementDto: CreateProcurementDto,
  ) {
    return this.ingredientsService.createProcurement(
      user.tenantId,
      skuId,
      createProcurementDto,
    );
  }
}
