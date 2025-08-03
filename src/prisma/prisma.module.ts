import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // 将此模块设为全局模块，这样其他模块无需导入即可使用PrismaService
@Module({
    providers: [PrismaService],
    exports: [PrismaService], // 导出PrismaService，使其可在其他模块中注入
})
export class PrismaModule {}
