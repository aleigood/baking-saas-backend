import { IsEnum, IsNotEmpty } from 'class-validator';
import { ProductionTaskStatus } from '@prisma/client';

/**
 * 更新生产任务状态的数据传输对象
 */
export class UpdateProductionTaskDto {
  @IsEnum(ProductionTaskStatus)
  @IsNotEmpty()
  status: ProductionTaskStatus;
}
