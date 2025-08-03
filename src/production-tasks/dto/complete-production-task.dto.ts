import { IsNumber, IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * 完成生产任务的数据传输对象
 */
export class CompleteProductionTaskDto {
  @IsNumber()
  @IsNotEmpty()
  actualQuantity: number; // 实际产出的数量

  @IsString()
  @IsOptional()
  notes?: string; // 生产日志的备注
}
