import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { RecipesModule } from './recipes/recipes.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { TasksModule } from './tasks/tasks.module'; // 1. 导入TasksModule
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    RecipesModule,
    IngredientsModule,
    TasksModule,
    TenantsModule, // 2. 在这里注册新模块
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
