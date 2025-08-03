import { ProductionTaskStatus } from '@prisma/client';
// [FIX] 导入 IsDateString 验证器
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export class QueryProductionTaskDto {
  @IsEnum(ProductionTaskStatus)
  @IsOptional()
  status?: ProductionTaskStatus;

  /**
   * [FIX] 新增 plannedDate 属性以支持按日期筛选
   * 使用 IsDateString 确保传入的是有效的日期字符串
   */
  @IsDateString()
  @IsOptional()
  plannedDate?: string;
}
