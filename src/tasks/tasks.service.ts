import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  create(createTaskDto: CreateTaskDto, user: UserPayload) {
    return this.prisma.productionTask.create({
      data: {
        ...createTaskDto,
        tenantId: user.tenantId,
        creatorId: user.userId,
      },
    });
  }

  // [核心新增] 获取指定店铺的制作任务列表
  async findAllForTenant(tenantId: string) {
    const tasks = await this.prisma.productionTask.findMany({
      where: { tenantId },
      include: { product: true, creator: true }, // 关联查询产品和创建者信息
      orderBy: { createdAt: 'desc' },
    });

    // 将数据库返回的结构，映射为前端需要的格式
    return tasks.map((task) => ({
      id: task.id,
      recipeName: task.product.name,
      time: task.createdAt.toISOString(),
      creator: task.creator.name,
      status: task.status,
    }));
  }

  async updateStatus(
    id: string,
    updateTaskStatusDto: UpdateTaskStatusDto,
    user: UserPayload,
  ) {
    const task = await this.prisma.productionTask.findUnique({
      where: { id },
    });

    if (!task || task.tenantId !== user.tenantId) {
      throw new NotFoundException('任务不存在或无权操作');
    }

    return this.prisma.productionTask.update({
      where: { id },
      data: {
        status: updateTaskStatusDto.status,
        completedAt:
          updateTaskStatusDto.status === 'COMPLETED' ? new Date() : null,
      },
    });
  }
}
