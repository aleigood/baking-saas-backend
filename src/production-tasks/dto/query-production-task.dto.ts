import { ProductionTaskStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsArray, IsIn, IsNumberString } from 'class-validator';

export class QueryProductionTaskDto {
    // NestJS 的 ValidationPipe 在 transform: true 的情况下，会自动将重复的查询参数 (如 status=A&status=B) 转换为数组。
    // 这种方式更标准，不再需要手动的字符串分割。
    @IsOptional()
    @IsEnum(ProductionTaskStatus, { each: true })
    @IsArray()
    @IsIn(Object.values(ProductionTaskStatus), { each: true })
    status?: ProductionTaskStatus[];

    /**
     * [FIX] 新增 plannedDate 属性以支持按日期筛选
     * 使用 IsDateString 确保传入的是有效的日期字符串
     */
    @IsDateString()
    @IsOptional()
    plannedDate?: string;

    // [ADDED] 新增分页参数
    @IsNumberString()
    @IsOptional()
    page?: string;

    @IsNumberString()
    @IsOptional()
    limit?: string;
}
