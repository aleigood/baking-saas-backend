import { Module } from '@nestjs/common';
import { CostingService } from './costing.service';
import { CostingController } from './costing.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module'; // [FIX] 导入 AuthModule 以提供认证守卫所需的依赖

@Module({
    imports: [PrismaModule, AuthModule], // [FIX] 将 AuthModule 添加到 imports 数组中
    controllers: [CostingController],
    providers: [CostingService],
    exports: [CostingService],
})
export class CostingModule {}
