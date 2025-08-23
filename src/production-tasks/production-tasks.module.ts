import { Module } from '@nestjs/common';
import { ProductionTasksService } from './production-tasks.service';
import { ProductionTasksController } from './production-tasks.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { CostingModule } from '../costing/costing.module';

@Module({
    imports: [PrismaModule, CostingModule],
    controllers: [ProductionTasksController],
    providers: [ProductionTasksService],
    exports: [ProductionTasksService], // [核心新增] 导出服务
})
export class ProductionTasksModule {}
