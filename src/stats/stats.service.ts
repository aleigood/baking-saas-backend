import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StatsDto } from './dto/stats.dto';
import { ProductionTaskStatus } from '@prisma/client';

@Injectable()
export class StatsService {
    constructor(private prisma: PrismaService) {}

    /**
     * [新增] 获取生产主页的核心统计指标
     * @param tenantId 租户ID
     */
    async getProductionHomeStats(tenantId: string) {
        // [修正] 使用原生JavaScript Date对象计算本周的起止日期 (周一到周日)
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 只取年月日，忽略时间
        const dayOfWeek = today.getDay(); // 0 = 周日, 1 = 周一, ..., 6 = 周六

        // 计算周一的日期。如果今天是周日(0)，则减去6天；否则，减去(dayOfWeek - 1)天。
        const startOfThisWeek = new Date(today);
        const dateOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        startOfThisWeek.setDate(today.getDate() + dateOffset);

        // 计算周日的日期
        const endOfThisWeek = new Date(startOfThisWeek);
        endOfThisWeek.setDate(startOfThisWeek.getDate() + 6);
        endOfThisWeek.setHours(23, 59, 59, 999); // 包含周日全天

        // 并行查询待完成任务总数和本周已完成任务总数
        const [pendingTasks, completedThisWeekTasks] = await this.prisma.$transaction([
            // 查询所有状态为 PENDING 或 IN_PROGRESS 的任务
            this.prisma.productionTask.findMany({
                where: {
                    tenantId,
                    status: {
                        in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                    },
                    deletedAt: null,
                },
                include: {
                    items: true, // 包含任务项以计算总数
                },
            }),
            // 查询本周内已完成的任务
            this.prisma.productionTask.findMany({
                where: {
                    tenantId,
                    status: ProductionTaskStatus.COMPLETED,
                    deletedAt: null,
                    log: {
                        completedAt: {
                            gte: startOfThisWeek,
                            lte: endOfThisWeek,
                        },
                    },
                },
                include: {
                    items: true, // 包含任务项以计算总数
                },
            }),
        ]);

        // 计算待完成总数
        const totalPendingCount = pendingTasks.reduce((sum, task) => {
            return sum + task.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
        }, 0);

        // 计算本周已完成总数
        const totalCompletedThisWeekCount = completedThisWeekTasks.reduce((sum, task) => {
            return sum + task.items.reduce((itemSum, item) => itemSum + item.quantity, 0);
        }, 0);

        return {
            pendingCount: totalPendingCount,
            completedThisWeekCount: totalCompletedThisWeekCount,
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

        // [核心新增] 计算已完成的任务总数
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
            totalTasks, // [核心新增] 返回任务总数
            productStats: Array.from(productStatsMap.values()),
            ingredientConsumption: consumptionStats.map((s) => ({
                name: ingredientMap.get(s.ingredientId) || '未知原料',
                consumedGrams: s._sum.quantityInGrams || 0,
            })),
        };
    }
}
