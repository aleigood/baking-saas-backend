/**
 * 文件路径: src/fermentation/fermentation.controller.ts
 * 文件描述: [新增] 暴露用于查询发酵用量的API接口。
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
    @ApiOperation({ summary: '获取可用的温度列表 (华氏度)' })
    @ApiQuery({ name: 'type', enum: FermentationType, required: true })
    @ApiResponse({ status: 200, description: '成功返回温度列表' })
    getAvailableTemperatures(@Query('type') type: FermentationType) {
        return this.fermentationService.getAvailableTemperatures(type);
    }

    @Get('times')
    @ApiOperation({ summary: '根据温度获取可用的发酵时间列表' })
    @ApiQuery({ name: 'type', enum: FermentationType, required: true })
    @ApiQuery({ name: 'temperatureF', type: Number, required: true, description: '华氏温度' })
    @ApiResponse({ status: 200, description: '成功返回时间列表' })
    getAvailableTimes(@Query('type') type: FermentationType, @Query('temperatureF') temperatureF: string) {
        return this.fermentationService.getAvailableTimes(type, parseFloat(temperatureF));
    }

    @Get('amount')
    @ApiOperation({ summary: '查询在特定条件下的酵母/鲁邦种用量' })
    @ApiResponse({ status: 200, description: '成功返回用量百分比数组', type: [Number] })
    findAmount(
        @Query(new ValidationPipe({ transform: true, whitelist: true }))
        query: QueryFermentationDto,
    ) {
        const { type, brand, temperatureF, time } = query;
        return this.fermentationService.findAmount(type, brand, temperatureF, time);
    }
}
