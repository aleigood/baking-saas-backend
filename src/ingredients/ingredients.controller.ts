import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { IngredientsService } from './ingredients.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateSkuDto } from './dto/create-sku.dto';
import { SetDefaultSkuDto } from './dto/set-default-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';

@UseGuards(AuthGuard('jwt'))
@Controller() // 使用空的Controller路径，在方法上定义完整路径
export class IngredientsController {
  constructor(private readonly ingredientsService: IngredientsService) {}

  // --- Endpoints for Ingredients ---
  @Post('ingredients')
  createIngredient(
    @GetUser() user: UserPayload,
    @Body() createIngredientDto: CreateIngredientDto,
  ) {
    return this.ingredientsService.createIngredient(
      user.tenantId,
      createIngredientDto,
    );
  }

  @Get('ingredients')
  findAllIngredients(@GetUser() user: UserPayload) {
    return this.ingredientsService.findAllIngredients(user.tenantId);
  }

  @Get('ingredients/:id')
  findOneIngredient(
    @GetUser() user: UserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ingredientsService.findOneIngredient(user.tenantId, id);
  }

  @Patch('ingredients/:id')
  updateIngredient(
    @GetUser() user: UserPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateIngredientDto: UpdateIngredientDto,
  ) {
    return this.ingredientsService.updateIngredient(
      user.tenantId,
      id,
      updateIngredientDto,
    );
  }

  @Delete('ingredients/:id')
  removeIngredient(
    @GetUser() user: UserPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ingredientsService.removeIngredient(user.tenantId, id);
  }

  // --- Endpoints for SKUs (nested under ingredients) ---
  @Post('ingredients/:ingredientId/skus')
  createSku(
    @GetUser() user: UserPayload,
    @Param('ingredientId', ParseUUIDPipe) ingredientId: string,
    @Body() createSkuDto: CreateSkuDto,
  ) {
    return this.ingredientsService.createSku(
      user.tenantId,
      ingredientId,
      createSkuDto,
    );
  }

  @Post('ingredients/:ingredientId/default-sku')
  setDefaultSku(
    @GetUser() user: UserPayload,
    @Param('ingredientId', ParseUUIDPipe) ingredientId: string,
    @Body() setDefaultSkuDto: SetDefaultSkuDto,
  ) {
    return this.ingredientsService.setDefaultSku(
      user.tenantId,
      ingredientId,
      setDefaultSkuDto,
    );
  }

  // --- Endpoint for Procurements ---
  @Post('procurements')
  createProcurement(
    @GetUser() user: UserPayload,
    @Body() createProcurementDto: CreateProcurementDto,
  ) {
    return this.ingredientsService.createProcurement(
      user.tenantId,
      createProcurementDto,
    );
  }
}
