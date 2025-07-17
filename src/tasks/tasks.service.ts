/**
 * 文件路径: src/tasks/tasks.service.ts
 * 文件描述: 处理制作任务的创建、状态更新，以及最核心的原料消耗计算逻辑。
 */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { ProductionTaskStatus } from '@prisma/client';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  /**
   * 创建一个新的制作任务
   * @param createTaskDto - 包含产品ID和计划数量的DTO
   * @param user - 当前用户信息
   */
  async create(createTaskDto: CreateTaskDto, user: UserPayload) {
    const { productId, plannedQuantity } = createTaskDto;

    // 验证产品是否存在
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException(`ID为 ${productId} 的产品不存在`);
    }

    // 验证产品是否属于当前租户
    const recipeFamily = await this.prisma.recipeFamily.findUnique({
      where: { id: product.recipeFamilyId },
    });
    // --- 修复点 1: 增加对 recipeFamily 的 null 检查 ---
    if (!recipeFamily) {
      throw new NotFoundException(
        `ID为 ${product.recipeFamilyId} 的配方家族不存在`,
      );
    }
    if (recipeFamily.tenantId !== user.tenantId) {
      throw new ForbiddenException('您无权使用此产品配方');
    }

    // 创建任务记录
    return this.prisma.productionTask.create({
      data: {
        productId,
        plannedQuantity,
        tenantId: user.tenantId,
        creatorId: user.userId,
      },
    });
  }

  /**
   * 更新任务状态，并在完成后触发库存扣减
   * @param taskId - 任务ID
   * @param updateTaskStatusDto - 包含新状态的DTO
   * @param user - 当前用户信息
   */
  async updateStatus(
    taskId: string,
    updateTaskStatusDto: UpdateTaskStatusDto,
    user: UserPayload,
  ) {
    const { status } = updateTaskStatusDto;

    // 1. 查找任务并验证归属权
    const task = await this.prisma.productionTask.findUnique({
      where: { id: taskId },
    });
    if (!task) {
      throw new NotFoundException(`ID为 ${taskId} 的任务不存在`);
    }
    if (task.tenantId !== user.tenantId) {
      throw new ForbiddenException('您无权操作此任务');
    }
    if (task.status !== ProductionTaskStatus.IN_PROGRESS) {
      throw new BadRequestException(`任务当前状态为 ${task.status}，无法更新`);
    }

    // 2. 如果任务是完成，则执行核心的消耗逻辑
    if (status === ProductionTaskStatus.COMPLETED) {
      await this.handleTaskCompletion(task);
    }

    // 3. 更新任务自身的状态
    return this.prisma.productionTask.update({
      where: { id: taskId },
      data: {
        status,
        completedAt:
          status === ProductionTaskStatus.COMPLETED ? new Date() : null,
      },
    });
  }

  /**
   * 处理任务完成的核心逻辑：计算并记录原料消耗
   * @param task - 已完成的任务对象
   */
  private async handleTaskCompletion(task: {
    id: string;
    productId: string;
    plannedQuantity: number;
  }) {
    // 1. 获取任务对应的产品及其完整配方信息
    const product = await this.prisma.product.findUnique({
      where: { id: task.productId },
      include: {
        mixIns: { include: { ingredient: true } },
        recipeFamily: {
          include: {
            doughs: {
              include: {
                ingredients: { include: { ingredient: true } },
              },
            },
          },
        },
      },
    });

    // --- 修复点 2: 增加对 product 的 null 检查 ---
    if (!product) {
      // 理论上不应该发生，因为创建任务时已验证过，但为了代码健壮性，增加此检查
      throw new NotFoundException(`任务关联的产品ID ${task.productId} 不存在`);
    }

    // 2. 计算总面团重量
    const totalDoughWeight = product.weight * task.plannedQuantity;

    // 3. 计算配方中所有原料的总百分比
    let totalRatio = 0;
    product.recipeFamily.doughs.forEach((dough) => {
      dough.ingredients.forEach((ing) => (totalRatio += ing.ratio));
    });
    product.mixIns.forEach((mixIn) => (totalRatio += mixIn.ratio));

    // 4. 计算每种原料的消耗量并准备好消耗记录
    // --- 修复点 3: 为 consumptionRecords 数组提供明确的类型定义 ---
    const consumptionRecords: {
      taskId: string;
      ingredientId: string;
      amountConsumedInGrams: number;
    }[] = [];

    // 计算主面团和预发酵面团中原料的消耗
    product.recipeFamily.doughs.forEach((dough) => {
      dough.ingredients.forEach((ing) => {
        const amountConsumed = (ing.ratio / totalRatio) * totalDoughWeight;
        consumptionRecords.push({
          taskId: task.id,
          ingredientId: ing.ingredientId,
          amountConsumedInGrams: amountConsumed,
        });
      });
    });

    // 计算混入面团的额外原料的消耗
    product.mixIns.forEach((mixIn) => {
      const amountConsumed = (mixIn.ratio / totalRatio) * totalDoughWeight;
      consumptionRecords.push({
        taskId: task.id,
        ingredientId: mixIn.ingredientId,
        amountConsumedInGrams: amountConsumed,
      });
    });

    // 5. 使用事务一次性创建所有消耗记录
    await this.prisma.consumptionRecord.createMany({
      data: consumptionRecords,
    });
  }
}
