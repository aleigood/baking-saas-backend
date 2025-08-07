import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CostingService } from './costing.service';
// [FIX] 修复守卫的使用方式，与项目中其他控制器（如 members.controller.ts）保持一致
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from 'src/auth/decorators/get-user.decorator';
import { UserPayload } from 'src/auth/interfaces/user-payload.interface';

// [FIX] 使用 NestJS 内置的 AuthGuard('jwt')，而不是不存在的自定义 JwtAuthGuard
@UseGuards(AuthGuard('jwt'))
@Controller('costing')
export class CostingController {
    constructor(private readonly costingService: CostingService) {}

    /**
     * 计算指定产品的总成本
     * @param user 认证用户
     * @param productId 产品ID
     * @returns 产品的成本分析
     */
    @Get('products/:productId')
    async getProductCost(@GetUser() user: UserPayload, @Param('productId') productId: string) {
        // 调用服务方法并等待结果
        return await this.costingService.calculateProductCost(user.tenantId, productId);
    }

    /**
     * [核心新增] 获取指定产品的成本历史记录
     * @param user 认证用户
     * @param productId 产品ID
     * @returns 成本历史数据点数组
     */
    @Get('products/:productId/cost-history')
    async getProductCostHistory(@GetUser() user: UserPayload, @Param('productId') productId: string) {
        return this.costingService.getProductCostHistory(user.tenantId, productId);
    }

    /**
     * [核心新增] 获取产品中各原料的成本构成
     * @param user 认证用户
     * @param productId 产品ID
     * @returns 各原料成本构成的数组
     */
    @Get('products/:productId/cost-breakdown')
    async getProductCostBreakdown(@GetUser() user: UserPayload, @Param('productId') productId: string) {
        return this.costingService.calculateIngredientCostBreakdown(user.tenantId, productId);
    }

    /**
     * [新增] 获取指定原料的成本历史记录
     * @param user 认证用户
     * @param ingredientId 原料ID
     * @returns 成本历史数据点数组
     */
    @Get('ingredients/:ingredientId/cost-history')
    async getIngredientCostHistory(@GetUser() user: UserPayload, @Param('ingredientId') ingredientId: string) {
        return this.costingService.getIngredientCostHistory(user.tenantId, ingredientId);
    }
}
