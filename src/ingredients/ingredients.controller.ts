import {
    Controller,
    Get,
    Post,
    Body,
    Patch,
    Param,
    Delete,
    UseGuards,
    HttpStatus,
    Query,
    ValidationPipe,
} from '@nestjs/common';
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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
// [核心新增] 导入分页查询 DTO
import { QueryLedgerDto } from './dto/query-ledger.dto';

@ApiTags('Ingredients')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('ingredients')
export class IngredientsController {
    constructor(private readonly ingredientsService: IngredientsService) {}

    @Post()
    @ApiOperation({ summary: 'Create a new ingredient' })
    @ApiResponse({ status: HttpStatus.CREATED, description: 'The ingredient has been successfully created.' })
    @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized.' })
    create(@GetUser() user: UserPayload, @Body() createIngredientDto: CreateIngredientDto) {
        return this.ingredientsService.create(user.tenantId, createIngredientDto);
    }

    @Get()
    @ApiOperation({ summary: 'Get all ingredients for the tenant' })
    @ApiResponse({ status: HttpStatus.OK, description: 'Return all ingredients.' })
    findAll(@GetUser() user: UserPayload) {
        return this.ingredientsService.findAll(user.tenantId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a single ingredient by ID' })
    findOne(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.ingredientsService.findOne(user.tenantId, id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update an ingredient' })
    update(@GetUser() user: UserPayload, @Param('id') id: string, @Body() updateIngredientDto: UpdateIngredientDto) {
        return this.ingredientsService.update(user.tenantId, id, updateIngredientDto);
    }

    @Patch(':id/stock')
    @ApiOperation({ summary: 'Adjust ingredient stock' })
    adjustStock(@GetUser() user: UserPayload, @Param('id') id: string, @Body() adjustStockDto: AdjustStockDto) {
        return this.ingredientsService.adjustStock(user.tenantId, id, user.sub, adjustStockDto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an ingredient' })
    remove(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.ingredientsService.remove(user.tenantId, id);
    }

    /**
     * [修改] 获取单个原料的库存流水 (支持分页)
     * @param user 当前用户
     * @param id 原料ID
     * @param queryDto 分页参数
     */
    @Get(':id/ledger')
    @ApiOperation({ summary: "Get an ingredient's stock ledger" })
    getIngredientLedger(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        // [核心修改] 应用 ValidationPipe 以便转换查询参数
        @Query(new ValidationPipe({ transform: true })) queryDto: QueryLedgerDto,
    ) {
        return this.ingredientsService.getIngredientLedger(user.tenantId, id, queryDto);
    }

    @Post(':ingredientId/skus')
    @ApiOperation({ summary: 'Create a new SKU for an ingredient' })
    createSku(
        @GetUser() user: UserPayload,
        @Param('ingredientId') ingredientId: string,
        @Body() createSkuDto: CreateSkuDto,
    ) {
        return this.ingredientsService.createSku(user.tenantId, ingredientId, createSkuDto);
    }

    @Delete('skus/:skuId')
    @ApiOperation({ summary: 'Delete a SKU' })
    deleteSku(@GetUser() user: UserPayload, @Param('skuId') skuId: string) {
        return this.ingredientsService.deleteSku(user.tenantId, skuId);
    }

    @Post(':ingredientId/active-sku')
    @ApiOperation({ summary: 'Set the active SKU for an ingredient' })
    setActiveSku(
        @GetUser() user: UserPayload,
        @Param('ingredientId') ingredientId: string,
        @Body() setActiveSkuDto: SetActiveSkuDto,
    ) {
        return this.ingredientsService.setActiveSku(user.tenantId, ingredientId, setActiveSkuDto);
    }

    @Post('skus/:skuId/procurements')
    @ApiOperation({ summary: 'Create a procurement record for a SKU' })
    createProcurement(
        @GetUser() user: UserPayload, // [核心修改] 注入当前用户信息
        @Param('skuId') skuId: string,
        @Body() createProcurementDto: CreateProcurementDto,
    ) {
        // [核心修改] 将 tenantId 和 userId 传递给 service 层
        return this.ingredientsService.createProcurement(user.tenantId, user.sub, skuId, createProcurementDto);
    }

    @Patch('procurements/:id')
    @ApiOperation({ summary: 'Update a procurement record' })
    updateProcurement(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        @Body() updateProcurementDto: UpdateProcurementDto,
    ) {
        return this.ingredientsService.updateProcurement(user.tenantId, id, updateProcurementDto);
    }
}
