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
import { SubscriptionGuard } from '../billing/subscription.guard';
import { CreateSkuDto } from './dto/create-sku.dto';
import { CreatePriceRecordDto } from './dto/create-price-record.dto';
import { SetActiveSkuDto } from './dto/set-active-sku.dto';
import { UpdatePriceRecordDto } from './dto/update-price-record.dto';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
// [新增] 导入 UpdateSkuDto
import { UpdateSkuDto } from './dto/update-sku.dto';
import { QueryConsumptionLedgerDto } from './dto/query-consumption-ledger.dto';

@ApiTags('Ingredients')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), SubscriptionGuard)
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

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an ingredient' })
    remove(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.ingredientsService.remove(user.tenantId, id);
    }

    @Get(':id/consumption-ledger')
    @ApiOperation({ summary: "Get an ingredient's consumption ledger" })
    getConsumptionLedger(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        @Query(new ValidationPipe({ transform: true })) queryDto: QueryConsumptionLedgerDto,
    ) {
        return this.ingredientsService.getConsumptionLedger(user.tenantId, id, queryDto);
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

    // [新增] 更新 SKU 路由
    @Patch('skus/:skuId')
    @ApiOperation({ summary: 'Update a SKU' })
    updateSku(@GetUser() user: UserPayload, @Param('skuId') skuId: string, @Body() updateSkuDto: UpdateSkuDto) {
        // [中文注释] 调用 service 层的方法
        return this.ingredientsService.updateSku(user.tenantId, skuId, updateSkuDto);
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

    @Post('skus/:skuId/price-records')
    @ApiOperation({ summary: 'Create a price record for a SKU' })
    createPriceRecord(
        @GetUser() user: UserPayload, // [核心修改] 注入当前用户信息
        @Param('skuId') skuId: string,
        @Body() createPriceRecordDto: CreatePriceRecordDto,
    ) {
        // [核心修改] 将 tenantId 和 userId 传递给 service 层
        return this.ingredientsService.createPriceRecord(user.tenantId, user.sub, skuId, createPriceRecordDto);
    }

    @Patch('price-records/:id')
    @ApiOperation({ summary: 'Update a price record' })
    updatePriceRecord(
        @GetUser() user: UserPayload,
        @Param('id') id: string,
        @Body() updatePriceRecordDto: UpdatePriceRecordDto,
    ) {
        return this.ingredientsService.updatePriceRecord(user.tenantId, id, updatePriceRecordDto);
    }
}
