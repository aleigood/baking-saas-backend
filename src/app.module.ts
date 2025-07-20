import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { RecipesModule } from './recipes/recipes.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { TasksModule } from './tasks/tasks.module';
import { MembersModule } from './members/members.module'; // 1. 导入新模块
import { StatsModule } from './stats/stats.module'; // 2. 导入新模块

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    TenantsModule,
    RecipesModule,
    IngredientsModule,
    TasksModule,
    MembersModule, // 3. 注册新模块
    StatsModule, // 4. 注册新模块
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
