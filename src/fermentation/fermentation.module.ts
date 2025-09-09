/**
 * 文件路径: src/fermentation/fermentation.module.ts
 * 文件描述: [新增] 定义发酵计算模块。
 */
import { Module } from '@nestjs/common';
import { FermentationController } from './fermentation.controller';
import { FermentationService } from './fermentation.service';

@Module({
    controllers: [FermentationController],
    providers: [FermentationService],
    exports: [FermentationService], // 导出服务以便其他模块将来可能使用
})
export class FermentationModule {}
