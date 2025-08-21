import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards } from '@nestjs/common';
import { IngredientsService } from './ingredients.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { UserPayload } from 'src/auth/interfaces/user-payload.interface';
import { AuthGuard } from '@nestjs/passport';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@UseGuards(AuthGuard('jwt'))
@Controller('ingredients')
export class IngredientsController {
    constructor(private readonly ingredientsService: IngredientsService) {}

    @Post()
    create(@GetUser() user: UserPayload, @Body() createIngredientDto: CreateIngredientDto) {
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
    update(@GetUser() user: UserPayload, @Param('id') id: string, @Body() updateIngredientDto: UpdateIngredientDto) {
        return this.ingredientsService.update(user.tenantId, id, updateIngredientDto);
    }

    @Patch(':id/stock')
    adjustStock(@GetUser() user: UserPayload, @Param('id') id: string, @Body() adjustStockDto: AdjustStockDto) {
        return this.ingredientsService.adjustStock(user.tenantId, id, user.sub, adjustStockDto);
    }

    @Delete(':id')
    remove(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.ingredientsService.remove(user.tenantId, id);
    }

    /**
     * [新增] 获取单个原料的库存流水
     * @param user 当前用户
     * @param id 原料ID
     */
    @Get(':id/ledger')
    getIngredientLedger(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.ingredientsService.getIngredientLedger(user.tenantId, id);
    }

    @Post(':ingredientId/skus')
    createSku(
        @GetUser() user: UserPayload,
        @Param('ingredientId') ingredientId: string,
        @Body() createSkuDto: CreateSkuDto,
    ) {
        return this.ingredientsService.createSku(user.tenantId, ingredientId, createSkuDto);
    }

    @Delete('skus/:skuId')
    deleteSku(@GetUser() user: UserPayload, @Param('skuId') skuId: string) {
        return this.ingredientsService.deleteSku(user.tenantId, skuId);
    }

    @Post(':ingredientId/active-sku')
    setActiveSku(
        @GetUser() user: UserPayload,
        @Param('ingredientId') ingredientId: string,
        @Body() setActiveSkuDto: SetActiveSkuDto,
    ) {
        return this.ingredientsService.setActiveSku(user.tenantId, ingredientId, setActiveSkuDto);
    }

    @Post('skus/:skuId/procurements')
    createProcurement(
        @GetUser() user: UserPayload,
        @Param('skuId') skuId: string,
        @Body() createProcurementDto: CreateProcurementDto,
    ) {
        return this.ingredientsService.createProcurement(user.tenantId, skuId, createProcurementDto);
    }

    @Patch('procurements/:id')
    updateProcurement(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        @Body() updateProcurementDto: UpdateProcurementDto,
    ) {
        return this.ingredientsService.updateProcurement(user.tenantId, id, updateProcurementDto);
    }
}
