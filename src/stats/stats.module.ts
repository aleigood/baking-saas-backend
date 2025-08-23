import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
import { ProductionTasksModule } from '../production-tasks/production-tasks.module'; // [核心新增] 导入任务模块

@Module({
    imports: [ProductionTasksModule], // [核心新增] 注入模块
    controllers: [StatsController],
    providers: [StatsService],
})
export class StatsModule {}
