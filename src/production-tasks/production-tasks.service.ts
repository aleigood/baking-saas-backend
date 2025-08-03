import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { ProductionTaskStatus, Prisma } from '@prisma/client';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';

@Injectable()
export class ProductionTasksService {
  constructor(private prisma: PrismaService) {}

  // ... create 方法保持不变 ...
  async create(tenantId: string, createDto: CreateProductionTaskDto) {
    const { recipeVersionId, productId, quantity, unit, plannedDate, notes } =
      createDto;

    const recipeVersion = await this.prisma.recipeVersion.findFirst({
      where: { id: recipeVersionId, family: { tenantId: tenantId } },
    });
    if (!recipeVersion) {
      throw new NotFoundException(
        `ID为 ${recipeVersionId} 的配方版本不存在或不属于该租户。`,
      );
    }

    if (productId) {
      const product = await this.prisma.product.findFirst({
        where: { id: productId, recipeVersionId: recipeVersionId },
      });
      if (!product) {
        throw new NotFoundException(
          `ID为 ${productId} 的产品不存在或不属于该配方版本。`,
        );
      }
    }

    return this.prisma.productionTask.create({
      data: {
        tenantId,
        recipeVersionId,
        productId,
        quantity,
        unit,
        plannedDate: new Date(plannedDate),
        notes,
      },
    });
  }

  /**
   * 查询指定租户的所有生产任务（支持过滤和分页）
   * @param tenantId 租户ID
   * @param queryDto 查询参数
   * @returns 分页后的生产任务列表及元数据
   */
  async findAll(tenantId: string, queryDto: QueryProductionTaskDto) {
    const { status, dateFrom, dateTo, page = '1', limit = '10' } = queryDto;
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // 构建动态查询条件
    const where: Prisma.ProductionTaskWhereInput = {
      tenantId,
      deletedAt: null,
      ...(status && { status }),
      ...(dateFrom &&
        dateTo && {
          plannedDate: {
            gte: new Date(dateFrom),
            lte: new Date(dateTo),
          },
        }),
    };

    const [tasks, total] = await this.prisma.$transaction([
      this.prisma.productionTask.findMany({
        where,
        include: {
          recipeVersion: {
            include: {
              family: {
                select: { name: true },
              },
            },
          },
          product: {
            select: { name: true },
          },
        },
        orderBy: { plannedDate: 'asc' },
        skip,
        take: limitNum,
      }),
      this.prisma.productionTask.count({ where }),
    ]);

    return {
      data: tasks,
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        lastPage: Math.ceil(total / limitNum),
      },
    };
  }

  // ... findOne, update, complete, remove 方法保持不变 ...
  async findOne(tenantId: string, id: string) {
    const task = await this.prisma.productionTask.findFirst({
      where: { id, tenantId, deletedAt: null },
      include: {
        recipeVersion: {
          include: {
            family: true,
            doughs: { include: { ingredients: true } },
          },
        },
        product: true,
      },
    });
    if (!task) {
      throw new NotFoundException(`ID为 ${id} 的生产任务不存在。`);
    }
    return task;
  }

  async update(
    tenantId: string,
    id: string,
    updateDto: UpdateProductionTaskDto,
  ) {
    await this.findOne(tenantId, id);
    return this.prisma.productionTask.update({
      where: { id },
      data: { status: updateDto.status },
    });
  }

  async complete(
    tenantId: string,
    id: string,
    completeDto: CompleteProductionTaskDto,
  ) {
    const task = await this.prisma.productionTask.findFirst({
      where: { id, tenantId },
      include: {
        product: true,
        recipeVersion: {
          include: {
            doughs: {
              include: {
                ingredients: {
                  include: {
                    linkedPreDough: {
                      include: {
                        versions: {
                          where: { isActive: true },
                          take: 1,
                          include: {
                            doughs: {
                              include: {
                                ingredients: true,
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!task) {
      throw new NotFoundException(`ID为 ${id} 的生产任务不存在。`);
    }
    if (task.status === 'COMPLETED') {
      throw new BadRequestException('该任务已完成，无法重复操作。');
    }

    const { actualQuantity, notes } = completeDto;
    const mainDough = task.recipeVersion.doughs[0];
    if (!mainDough) {
      throw new BadRequestException('配方数据不完整，缺少面团定义。');
    }

    const totalFlourRatio = mainDough.ingredients
      .filter((ing) => ing.isFlour)
      .reduce((sum, ing) => sum + ing.ratio, 0);

    if (totalFlourRatio === 0) {
      throw new BadRequestException('配方中未定义面粉，无法计算消耗。');
    }

    let totalFlourWeight = 0;
    if (task.unit === '件' && task.product) {
      totalFlourWeight =
        (task.product.baseDoughWeight / totalFlourRatio) * 100 * actualQuantity;
    } else if (task.unit === '克') {
      totalFlourWeight = actualQuantity;
    } else {
      throw new BadRequestException('未知的任务单位或缺少产品信息。');
    }

    const consumptionMap = new Map<string, number>();

    for (const ingredient of mainDough.ingredients) {
      const consumedWeight = (ingredient.ratio / 100) * totalFlourWeight;

      if (ingredient.linkedPreDough && ingredient.linkedPreDough.versions[0]) {
        const preDoughVersion = ingredient.linkedPreDough.versions[0];
        const preDoughDef = preDoughVersion.doughs[0];
        const preDoughTotalRatio = preDoughDef.ingredients.reduce(
          (sum, ing) => sum + ing.ratio,
          0,
        );

        for (const preDoughIng of preDoughDef.ingredients) {
          const finalConsumed =
            consumedWeight *
            (preDoughIng.ratio / preDoughTotalRatio) *
            (1 + (preDoughDef.lossRatio || 0));
          consumptionMap.set(
            preDoughIng.name,
            (consumptionMap.get(preDoughIng.name) || 0) + finalConsumed,
          );
        }
      } else {
        const finalConsumed = consumedWeight * (1 + (mainDough.lossRatio || 0));
        consumptionMap.set(
          ingredient.name,
          (consumptionMap.get(ingredient.name) || 0) + finalConsumed,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.productionTask.update({
        where: { id },
        data: { status: ProductionTaskStatus.COMPLETED },
      });

      const productionLog = await tx.productionLog.create({
        data: { taskId: id, actualQuantity, notes },
      });

      for (const [name, quantityInGrams] of consumptionMap.entries()) {
        const ingredientRecord = await tx.ingredient.findFirst({
          where: { tenantId, name },
        });

        if (ingredientRecord) {
          await tx.ingredientConsumptionLog.create({
            data: {
              productionLogId: productionLog.id,
              ingredientId: ingredientRecord.id,
              skuId: ingredientRecord.defaultSkuId,
              quantityInGrams,
            },
          });
        }
      }
      return productionLog;
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    return this.prisma.productionTask.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
