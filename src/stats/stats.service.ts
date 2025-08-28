import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StatsDto } from './dto/stats.dto';
import { ProductionTaskStatus } from '@prisma/client';
import { ProductionTasksService } from '../production-tasks/production-tasks.service';

@Injectable()
export class StatsService {
    constructor(
        private prisma: PrismaService,
        private readonly productionTasksService: ProductionTasksService,
    ) {}

    /**
     * [核心改造] 聚合接口不再返回 hasHistory 字段
     * @param tenantId 租户ID
     */
    async getProductionDashboard(tenantId: string) {
        // [修改] 调用 findActive 时不传参数，让其默认获取当天的任务
        const [stats, tasksPayload] = await Promise.all([
            this.getProductionHomeStats(tenantId),
            this.productionTasksService.findActive(tenantId),
        ]);

        return {
            stats,
            tasks: tasksPayload.tasks,
            prepTask: tasksPayload.prepTask,
        };
    }

    /**
     * [修改] 获取生产主页的核心统计指标, 不再包含本周完成数量
     * @param tenantId 租户ID
     */
    async getProductionHomeStats(tenantId: string) {
        // [移除] 删除与“本周已完成”相关的日期计算逻辑
        const pendingTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                deletedAt: null,
            },
            include: {
                items: true,
            },
        });

        const totalPendingCount = pendingTasks.reduce((sum, task) => {
            return sum + task.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
        }, 0);

        // [修改] 只返回待完成数量
        return {
            pendingCount: totalPendingCount,
        };
    }

    async getProductionStats(tenantId: string, dto: StatsDto) {
        const { startDate, endDate } = dto;

        const startOfDay = new Date(startDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);

        const completedTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: 'COMPLETED',
                log: {
                    completedAt: {
                        gte: startOfDay,
                        lte: endOfDay,
                    },
                },
            },
            include: {
                items: {
                    include: {
                        product: { select: { id: true, name: true } },
                    },
                },
                log: true,
            },
        });

        const totalTasks = completedTasks.length;

        const productStatsMap = new Map<string, { name: string; count: number }>();
        for (const task of completedTasks) {
            for (const item of task.items) {
                if (item.productId) {
                    const existing = productStatsMap.get(item.productId);
                    const name = item.product?.name || '未知产品';
                    const count = (existing?.count || 0) + item.quantity;
                    productStatsMap.set(item.productId, { name, count });
                }
            }
        }

        const consumptionStats = await this.prisma.ingredientConsumptionLog.groupBy({
            by: ['ingredientId'],
            _sum: {
                quantityInGrams: true,
            },
            where: {
                productionLog: {
                    taskId: {
                        in: completedTasks.map((t) => t.id),
                    },
                },
            },
        });

        const ingredientIds = consumptionStats.map((s) => s.ingredientId);
        const ingredients = await this.prisma.ingredient.findMany({
            where: { id: { in: ingredientIds } },
            select: { id: true, name: true },
        });
        const ingredientMap = new Map(ingredients.map((i) => [i.id, i.name]));

        return {
            totalTasks,
            productStats: Array.from(productStatsMap.values()),
            ingredientConsumption: consumptionStats.map((s) => ({
                name: ingredientMap.get(s.ingredientId) || '未知原料',
                consumedGrams: s._sum.quantityInGrams || 0,
            })),
        };
    }
}
