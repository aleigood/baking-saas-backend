import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Role } from '@prisma/client';
import { AppDashboardDto } from './dto/app-dashboard.dto';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) {}

    async getAppDashboardStats(currentUser: UserPayload): Promise<AppDashboardDto> {
        // 如果是老板角色，执行跨店铺统计
        if (currentUser.role === Role.OWNER) {
            // 1. 找出老板拥有的所有店铺ID
            const ownerTenants = await this.prisma.tenantUser.findMany({
                where: {
                    userId: currentUser.sub,
                    role: Role.OWNER,
                },
                select: {
                    tenantId: true,
                },
            });
            const tenantIds = ownerTenants.map((t) => t.tenantId);

            if (tenantIds.length === 0) {
                return { totalTenants: 0, totalUsers: 0, totalRecipes: 0, totalTasks: 0 };
            }

            // 2. 并行执行所有聚合查询
            const [totalUsers, totalRecipes, totalTasks] = await Promise.all([
                // 统计所有名下店铺的总人数
                this.prisma.tenantUser.count({
                    where: { tenantId: { in: tenantIds } },
                }),
                // 统计所有名下店铺的总配方数
                this.prisma.recipeFamily.count({
                    where: { tenantId: { in: tenantIds }, deletedAt: null },
                }),
                // 统计所有名下店铺的总任务数
                this.prisma.productionTask.count({
                    where: { tenantId: { in: tenantIds }, deletedAt: null },
                }),
            ]);

            return {
                totalTenants: tenantIds.length,
                totalUsers,
                totalRecipes,
                totalTasks,
            };
        } else {
            // 如果是管理员或员工，只统计当前店铺
            const tenantId = currentUser.tenantId;

            const [totalUsers, totalRecipes, totalTasks] = await Promise.all([
                // 统计当前店铺的总人数
                this.prisma.tenantUser.count({
                    where: { tenantId: tenantId },
                }),
                // 统计当前店铺的总配方数
                this.prisma.recipeFamily.count({
                    where: { tenantId: tenantId, deletedAt: null },
                }),
                // 统计当前店铺的总任务数
                this.prisma.productionTask.count({
                    where: { tenantId: tenantId, deletedAt: null },
                }),
            ]);

            return {
                totalUsers,
                totalRecipes,
                totalTasks,
            };
        }
    }
}
