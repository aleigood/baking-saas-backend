import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StatsDto } from './dto/stats.dto';

@Injectable()
export class StatsService {
    constructor(private prisma: PrismaService) {}

    async getProductionStats(tenantId: string, dto: StatsDto) {
        const { startDate, endDate } = dto;

        // [修改] 查询已完成的任务，并包含其所有的任务项(items)和产品信息
        // (Modified: Query for completed tasks, including all their items and product information)
        const completedTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: 'COMPLETED',
                log: {
                    completedAt: {
                        gte: new Date(startDate),
                        lte: new Date(endDate),
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

        // [修改] 重新构建产品统计逻辑以适应新的数据结构
        // (Modified: Rebuild product statistics logic for the new data structure)
        const productStatsMap = new Map<string, { name: string; count: number }>();
        for (const task of completedTasks) {
            for (const item of task.items) {
                if (item.productId) {
                    const existing = productStatsMap.get(item.productId);
                    const name = item.product?.name || '未知产品';
                    // 数量现在从每个任务项中获取
                    // (Quantity is now retrieved from each task item)
                    const count = (existing?.count || 0) + item.quantity;
                    productStatsMap.set(item.productId, { name, count });
                }
            }
        }

        // [修改] 消耗统计逻辑保持不变，因为它依赖于 taskId，这个关系没有改变
        // (Modified: Consumption statistics logic remains the same as it depends on taskId, which has not changed)
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
            productStats: Array.from(productStatsMap.values()),
            ingredientConsumption: consumptionStats.map((s) => ({
                name: ingredientMap.get(s.ingredientId) || '未知原料',
                consumedGrams: s._sum.quantityInGrams || 0,
            })),
        };
    }
}
