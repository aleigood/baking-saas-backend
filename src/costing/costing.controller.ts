import {
  Controller,
  Get,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CostingService } from './costing.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

// 导入CostDetail接口，或者将其移动到DTO文件中
import { CostDetail } from './costing.service';

@UseGuards(AuthGuard('jwt'))
@Controller('costing')
export class CostingController {
  constructor(private readonly costingService: CostingService) {}

  /**
   * 分析单个产品的理论成本构成
   * @param user 用户信息
   * @param productId 产品ID
   * @returns 产品的成本分析报告
   */
  @Get('product/:productId')
  async getProductCostAnalysis(
    @GetUser() user: UserPayload,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<{
    productName: string;
    recipeVersion: number;
    totalCost: string;
    costDetails: CostDetail[];
  }> {
    return this.costingService.analyzeProductCost(user.tenantId, productId);
  }
}
