import { Module } from '@nestjs/common';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { CostingModule } from '../costing/costing.module'; // 导入成本计算模块

@Module({
  imports: [CostingModule], // 导入 CostingModule 以使用其服务
  controllers: [RecipesController],
  providers: [RecipesService],
  exports: [RecipesService], // [新增] 导出 RecipesService 以便其他模块可以使用
})
export class RecipesModule {}
