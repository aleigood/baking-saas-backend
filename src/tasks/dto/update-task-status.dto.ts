/**
 * 文件路径: src/tasks/dto/update-task-status.dto.ts
 * 文件描述: 定义了更新任务状态所需的数据结构。
 */
import { ProductionTaskStatus } from '@prisma/client';

export class UpdateTaskStatusDto {
  status: ProductionTaskStatus; // 目标状态，如 'COMPLETED' 或 'CANCELED'
}
