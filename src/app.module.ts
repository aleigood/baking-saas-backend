import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module'; // 导入Prisma模块
import { AuthModule } from './auth/auth.module'; // 导入Auth模块

@Module({
  imports: [PrismaModule, AuthModule], // 在这里注册新模块
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
