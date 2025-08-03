import { Module } from '@nestjs/common';
import { CostingService } from './costing.service';
import { CostingController } from './costing.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [CostingService],
  controllers: [CostingController],
})
export class CostingModule {}
