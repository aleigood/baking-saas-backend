import { Module } from '@nestjs/common';
import { RecipesController } from './recipes.controller';
import { RecipesService } from './recipes.service';
import { CostingModule } from '../costing/costing.module'; // 导入成本计算模块
import { MulterModule } from '@nestjs/platform-express';

@Module({
    imports: [
        CostingModule,
        MulterModule.register({
            limits: {
                fileSize: 1024 * 1024 * 5, // 限制文件大小为 5MB
            },
        }),
    ], // [修改] 导入 CostingModule 和 MulterModule
    controllers: [RecipesController],
    providers: [RecipesService],
    exports: [RecipesService], // [新增] 导出 RecipesService 以便其他模块可以使用
})
export class RecipesModule {}
