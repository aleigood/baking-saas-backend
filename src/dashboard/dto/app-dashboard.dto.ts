/**
 * 文件路径: src/dashboard/dto/app-dashboard.dto.ts
 * 文件描述: [新增] 定义客户端“我的”页面看板所需的数据结构。
 */
export class AppDashboardDto {
    totalTenants?: number; // 店铺总数，可选，仅老板可见
    totalUsers: number; // 人员总数
    totalRecipes: number; // 配方总数
    totalTasks: number; // 生产任务总数
}
