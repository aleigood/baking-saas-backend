/**
 * 文件路径: src/production-tasks/dto/query-task-detail.dto.ts
 * 文件描述: [新增] 定义获取任务详情时，用于计算冰块用量的查询参数
 */
import { IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class QueryTaskDetailDto {
    @IsOptional()
    @IsNumber()
    @Type(() => Number) // 在 ValidationPipe 中启用 transform: true 时，确保查询参数字符串能正确转换为数字
    mixerType?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    envTemp?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    flourTemp?: number;

    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    waterTemp?: number;
}
