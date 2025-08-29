import { Module } from '@nestjs/common';
import { StatsService } from './stats.service';
import { StatsController } from './stats.controller';
// [核心修改] 移除了对 ProductionTasksModule 的导入，因为它不再被依赖

@Module({
    imports: [], // [核心修改] imports 数组现在为空
    controllers: [StatsController],
    providers: [StatsService],
})
export class StatsModule {}
