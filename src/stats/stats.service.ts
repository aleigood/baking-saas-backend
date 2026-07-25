import { Injectable } from '@nestjs/common';
import { Prisma, ProductionTaskStatus, RecipeType, TaskItemRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StatsDto } from './dto/stats.dto';
import { getUtcDayBounds } from 'src/common/utils/timezone.util';
// [核心修改] ProductionTasksService 的导入已移除，因为它不再被使用

@Injectable()
export class StatsService {
    constructor(
        private prisma: PrismaService,
        // [核心修改] 移除了对 productionTasksService 的依赖
    ) {}

    // [核心修改] 移除了已废弃的 getProductionDashboard 方法
    // [核心修改] 移除了已废弃的 getProductionHomeStats 方法

    async getProductionStats(tenantId: string, dto: StatsDto) {
        const { startDate, endDate } = dto;

        const { start: startOfDay } = getUtcDayBounds(startDate);
        const { end: endOfDay } = getUtcDayBounds(endDate);

        const completedTaskWhere = Prisma.sql`
            pt."tenantId" = ${tenantId}
            AND pt."status" = ${ProductionTaskStatus.COMPLETED}::"ProductionTaskStatus"
            AND pl."completedAt" >= ${startOfDay}
            AND pl."completedAt" <= ${endOfDay}
            AND EXISTS (
                SELECT 1
                FROM "ProductionTaskItem" pti_exists
                INNER JOIN "Product" p_exists ON p_exists."id" = pti_exists."productId"
                INNER JOIN "RecipeVersion" rv_exists ON rv_exists."id" = p_exists."recipeVersionId"
                INNER JOIN "RecipeFamily" rf_exists ON rf_exists."id" = rv_exists."familyId"
                WHERE pti_exists."taskId" = pt."id"
                    AND pti_exists."role" = ${TaskItemRole.FINAL_PRODUCT}::"TaskItemRole"
                    AND rf_exists."type" = ${RecipeType.MAIN}::"RecipeType"
            )
        `;

        const totalRows: { total: bigint }[] = await this.prisma.$queryRaw(
            Prisma.sql`
                SELECT COUNT(DISTINCT pt."id") AS total
                FROM "ProductionTask" pt
                INNER JOIN "ProductionLog" pl ON pl."taskId" = pt."id"
                WHERE ${completedTaskWhere}
            `,
        );

        const productStats: { name: string; count: number }[] = await this.prisma.$queryRaw(
            Prisma.sql`
                SELECT
                    p."name" AS name,
                    SUM(pti."quantity")::float AS count
                FROM "ProductionTaskItem" pti
                INNER JOIN "ProductionTask" pt ON pt."id" = pti."taskId"
                INNER JOIN "ProductionLog" pl ON pl."taskId" = pt."id"
                INNER JOIN "Product" p ON p."id" = pti."productId"
                INNER JOIN "RecipeVersion" rv ON rv."id" = p."recipeVersionId"
                INNER JOIN "RecipeFamily" rf ON rf."id" = rv."familyId"
                WHERE ${completedTaskWhere}
                    AND pti."role" = ${TaskItemRole.FINAL_PRODUCT}::"TaskItemRole"
                    AND rf."type" = ${RecipeType.MAIN}::"RecipeType"
                GROUP BY p."id", p."name"
                ORDER BY count DESC
            `,
        );

        const consumptionStats: { ingredientId: string; consumedGrams: number }[] = await this.prisma.$queryRaw(
            Prisma.sql`
                SELECT
                    icl."ingredientId",
                    SUM(icl."quantityInGrams")::float AS "consumedGrams"
                FROM "IngredientConsumptionLog" icl
                INNER JOIN "ProductionLog" pl ON pl."id" = icl."productionLogId"
                INNER JOIN "ProductionTask" pt ON pt."id" = pl."taskId"
                WHERE ${completedTaskWhere}
                GROUP BY icl."ingredientId"
            `,
        );

        const ingredientIds = consumptionStats.map((s) => s.ingredientId);
        const ingredients = await this.prisma.ingredient.findMany({
            where: { id: { in: ingredientIds } },
            select: { id: true, name: true },
        });
        const ingredientMap = new Map(ingredients.map((i) => [i.id, i.name]));

        return {
            totalTasks: Number(totalRows[0]?.total || 0),
            productStats,
            ingredientConsumption: consumptionStats.map((s) => ({
                name: ingredientMap.get(s.ingredientId) || '未知原料',
                consumedGrams: s.consumedGrams || 0,
            })),
        };
    }
}
