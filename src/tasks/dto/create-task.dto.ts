/**
 * 文件路径: src/tasks/dto/create-task.dto.ts
 * 文件描述: 定义了创建一个新制作任务所需的数据结构。
 */
export class CreateTaskDto {
  productId: string; // 要制作的最终产品的ID
  plannedQuantity: number; // 计划生产的数量
}
