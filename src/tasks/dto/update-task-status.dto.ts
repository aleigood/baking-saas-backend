/**
 * 文件路径: src/tasks/dto/update-task-status.dto.ts
 * 文件描述: (已重构) 添加了完整的 class-validator 验证装饰器。
 */
import { IsEnum } from 'class-validator';
import { ProductionTaskStatus } from '@prisma/client';

export class UpdateTaskStatusDto {
  @IsEnum(ProductionTaskStatus)
  status: ProductionTaskStatus;
}
