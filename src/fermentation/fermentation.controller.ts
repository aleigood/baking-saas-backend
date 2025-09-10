/**
 * 文件路径: src/fermentation/fermentation.controller.ts
 * 文件描述: [修改] 更新API接口文档和参数，统一使用摄氏度。
 */
import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { FermentationService } from './fermentation.service';
import { FermentationType, QueryFermentationDto } from './dto/query-fermentation.dto';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Fermentation')
@Controller('fermentation')
export class FermentationController {
    constructor(private readonly fermentationService: FermentationService) {}

    @Get('temperatures')
    @ApiOperation({ summary: '获取可用的温度列表 (摄氏度)' })
    @ApiQuery({ name: 'type', enum: FermentationType, required: true })
    @ApiResponse({ status: 200, description: '成功返回温度列表 (摄氏度)' })
    getAvailableTemperatures(@Query('type') type: FermentationType) {
        return this.fermentationService.getAvailableTemperatures(type);
    }

    @Get('times')
    @ApiOperation({ summary: '根据温度获取可用的发酵时间列表' })
    @ApiQuery({ name: 'type', enum: FermentationType, required: true })
    @ApiQuery({ name: 'temperatureC', type: Number, required: true, description: '摄氏温度' })
    @ApiResponse({ status: 200, description: '成功返回时间列表' })
    getAvailableTimes(@Query('type') type: FermentationType, @Query('temperatureC') temperatureC: string) {
        return this.fermentationService.getAvailableTimes(type, parseFloat(temperatureC));
    }

    @Get('amount')
    @ApiOperation({ summary: '查询在特定条件下的酵母/鲁邦种用量' })
    @ApiResponse({ status: 200, description: '成功返回用量百分比数组', type: [Number] })
    findAmount(
        @Query(new ValidationPipe({ transform: true, whitelist: true }))
        query: QueryFermentationDto,
    ) {
        const { type, brand, temperatureC, time } = query;
        return this.fermentationService.findAmount(type, brand, temperatureC, time);
    }
}
