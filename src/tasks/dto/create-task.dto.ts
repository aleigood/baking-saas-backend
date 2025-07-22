/**
 * 文件路径: src/tasks/dto/create-task.dto.ts
 * 文件描述: (已重构) 添加了完整的 class-validator 验证装饰器。
 */
import { IsString, IsNotEmpty, IsInt, IsPositive } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsInt()
  @IsPositive()
  plannedQuantity: number;
}
