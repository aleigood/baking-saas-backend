/**
 * 文件路径: src/super-admin/super-admin.module.ts
 * 文件描述: [新增] 定义超级管理员模块，整合其控制器和服务。
 */
import { Module } from '@nestjs/common';
import { SuperAdminController } from './super-admin.controller';
import { SuperAdminService } from './super-admin.service';
import { AuthModule } from '../auth/auth.module'; // 导入AuthModule以使用认证功能
import { RecipesModule } from '../recipes/recipes.module'; // [新增] 导入 RecipesModule

@Module({
  imports: [AuthModule, RecipesModule], // [修改] 添加 RecipesModule
  controllers: [SuperAdminController],
  providers: [SuperAdminService],
})
export class SuperAdminModule {}
