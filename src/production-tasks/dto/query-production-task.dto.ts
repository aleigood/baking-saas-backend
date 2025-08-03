import {
  IsOptional,
  IsEnum,
  IsDateString,
  IsNumberString,
} from 'class-validator';
import { ProductionTaskStatus } from '@prisma/client';

/**
 * 查询生产任务列表的查询参数DTO
 */
export class QueryProductionTaskDto {
  @IsOptional()
  @IsEnum(ProductionTaskStatus)
  status?: ProductionTaskStatus; // 按任务状态过滤

  @IsOptional()
  @IsDateString()
  dateFrom?: string; // 按计划日期的起始范围过滤

  @IsOptional()
  @IsDateString()
  dateTo?: string; // 按计划日期的结束范围过滤

  @IsOptional()
  @IsNumberString()
  page?: string = '1'; // 页码

  @IsOptional()
  @IsNumberString()
  limit?: string = '10'; // 每页数量
}
