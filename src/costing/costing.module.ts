/**
 * 文件路径: src/costing/costing.module.ts
 * 文件描述: 成本计算模块。
 */
import { Module } from '@nestjs/common';
import { CostingService } from './costing.service';
import { IngredientsModule } from '../ingredients/ingredients.module'; // 导入 IngredientsModule 以便使用其服务

@Module({
  // [注意] 我们需要一种方式让 CostingService 访问 IngredientsService 中的成本计算逻辑。
  // 更优的方案是将 IngredientsService 中的成本计算也移到 CostingService 中，
  // 但为保持模块独立性，我们暂时先创建一个专用于成本计算的服务。
  providers: [CostingService],
  exports: [CostingService], // 导出服务，以便其他模块可以使用
})
export class CostingModule {}
