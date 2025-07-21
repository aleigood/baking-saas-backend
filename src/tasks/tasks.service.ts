/**
 * 文件路径: src/tasks/tasks.service.ts
 * 文件描述: (功能完善) 实现了创建任务时，自动计算并生成原料消耗记录的逻辑。
 */
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException, // 引入 BadRequestException
} from '@nestjs/common';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { ProductionTaskStatus } from '@prisma/client';

@Injectable()
export class TasksService {
  constructor(private prisma: PrismaService) {}

  /**
   * [核心更新] 创建一个新的生产任务，并自动计算和生成原料消耗记录。
   * @param createTaskDto 包含产品ID和计划数量的DTO
   * @param user 当前用户信息
   */
  async create(createTaskDto: CreateTaskDto, user: UserPayload) {
    const { productId, plannedQuantity } = createTaskDto;
    const { tenantId, userId } = user;

    // 1. 首先，获取产品的完整配方信息
    const productRecipe = await this.prisma.product.findFirst({
      where: { id: productId, recipeFamily: { tenantId } },
      include: {
        recipeFamily: {
          include: {
            doughs: {
              include: {
                ingredients: { include: { ingredient: true } },
              },
            },
          },
        },
        mixIns: { include: { ingredient: true } },
        addOns: {
          include: {
            extra: {
              include: {
                ingredients: { include: { ingredient: true } },
              },
            },
          },
        },
      },
    });

    if (!productRecipe) {
      throw new NotFoundException(`ID为 ${productId} 的产品不存在或无权访问`);
    }

    // 2. 计算每种原料的总需求量
    const ingredientConsumptionMap = new Map<string, number>();

    // 2a. 计算所有面团中的总面粉烘焙百分比
    let totalFlourRatio = 0;
    productRecipe.recipeFamily.doughs.forEach((dough) => {
      dough.ingredients.forEach((ing) => {
        if (ing.isFlour) {
          totalFlourRatio += ing.ratio;
        }
      });
    });

    if (totalFlourRatio === 0) {
      throw new InternalServerErrorException(
        '配方中未标记任何原料为总面粉 (isFlour)，无法计算。',
      );
    }

    // 2b. 计算单个产品的总面粉重量（克）
    // 假设：产品克重(product.weight) = 所有面团原料 + 所有混入料原料的总重量
    let totalRatio = 0;
    productRecipe.recipeFamily.doughs.forEach((d) =>
      d.ingredients.forEach((i) => (totalRatio += i.ratio)),
    );
    productRecipe.mixIns.forEach((m) => (totalRatio += m.ratio));

    const singleProductTotalFlourWeight =
      (productRecipe.weight / totalRatio) * totalFlourRatio;

    // 2c. 计算面团和混入料中各种原料的消耗量
    const calculateConsumption = (
      items: { ratio: number; ingredient: { id: string } }[],
    ) => {
      items.forEach((item) => {
        const amount =
          (item.ratio / totalFlourRatio) *
          singleProductTotalFlourWeight *
          plannedQuantity;
        const currentAmount =
          ingredientConsumptionMap.get(item.ingredient.id) || 0;
        ingredientConsumptionMap.set(
          item.ingredient.id,
          currentAmount + amount,
        );
      });
    };

    productRecipe.recipeFamily.doughs.forEach((d) =>
      calculateConsumption(d.ingredients),
    );
    calculateConsumption(productRecipe.mixIns);

    // 2d. 计算附加项 (AddOns) 中各种原料的消耗量
    productRecipe.addOns.forEach((addOn) => {
      const totalAddOnWeight = addOn.weight * plannedQuantity;
      const extraRecipe = addOn.extra;
      const totalExtraRatio = extraRecipe.ingredients.reduce(
        (sum, ing) => sum + ing.ratio,
        0,
      );

      if (totalExtraRatio > 0) {
        extraRecipe.ingredients.forEach((ing) => {
          const amount = (ing.ratio / totalExtraRatio) * totalAddOnWeight;
          const currentAmount =
            ingredientConsumptionMap.get(ing.ingredient.id) || 0;
          ingredientConsumptionMap.set(
            ing.ingredient.id,
            currentAmount + amount,
          );
        });
      }
    });

    // 3. 在一个事务中创建任务和所有消耗记录
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.productionTask.create({
        data: {
          productId,
          plannedQuantity,
          tenantId,
          creatorId: userId,
        },
      });

      const consumptionRecords = Array.from(
        ingredientConsumptionMap.entries(),
      ).map(([ingredientId, amount]) => ({
        taskId: task.id,
        ingredientId: ingredientId,
        amountConsumedInGrams: amount,
      }));

      if (consumptionRecords.length > 0) {
        await tx.consumptionRecord.createMany({
          data: consumptionRecords,
        });
      }

      return task;
    });
  }

  async findAllForTenant(tenantId: string) {
    const tasks = await this.prisma.productionTask.findMany({
      where: { tenantId },
      include: { product: true, creator: true },
      orderBy: { createdAt: 'desc' },
    });

    return tasks.map((task) => ({
      id: task.id,
      recipeName: task.product.name,
      time: task.createdAt.toISOString(),
      creator: task.creator.name,
      status: task.status,
    }));
  }

  /**
   * [核心修复] 更新任务状态，并在取消时删除关联的消耗记录。
   * @param id 任务ID
   * @param updateTaskStatusDto 包含新状态的DTO
   * @param user 当前用户信息
   */
  async updateStatus(
    id: string,
    updateTaskStatusDto: UpdateTaskStatusDto,
    user: UserPayload,
  ) {
    const { status } = updateTaskStatusDto;

    return this.prisma.$transaction(async (tx) => {
      // 1. 验证任务是否存在且属于当前用户的店铺
      const task = await tx.productionTask.findFirst({
        where: {
          id,
          tenantId: user.tenantId,
        },
      });

      if (!task) {
        throw new NotFoundException('任务不存在或无权操作');
      }

      // [核心修复] 增加业务逻辑校验：已完成的任务不能被取消
      if (
        task.status === ProductionTaskStatus.COMPLETED &&
        status === ProductionTaskStatus.CANCELED
      ) {
        throw new BadRequestException('已完成的任务不能被取消。');
      }

      // 2. 如果任务被取消，则删除所有相关的消耗记录
      if (status === ProductionTaskStatus.CANCELED) {
        await tx.consumptionRecord.deleteMany({
          where: {
            taskId: id,
          },
        });
      }

      // 3. 更新任务本身的状态
      const updatedTask = await tx.productionTask.update({
        where: { id },
        data: {
          status: status,
          completedAt:
            status === ProductionTaskStatus.COMPLETED ? new Date() : null,
        },
      });

      return updatedTask;
    });
  }
}
