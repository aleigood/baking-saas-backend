import { Module } from '@nestjs/common';
import { ProductionTasksService } from './production-tasks.service';
import { ProductionTasksController } from './production-tasks.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
    imports: [PrismaModule],
    controllers: [ProductionTasksController],
    providers: [ProductionTasksService],
})
export class ProductionTasksModule {}
