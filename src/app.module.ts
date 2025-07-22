import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // [核心重构] 导入 ConfigModule
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { RecipesModule } from './recipes/recipes.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { TasksModule } from './tasks/tasks.module';
import { MembersModule } from './members/members.module';
import { StatsModule } from './stats/stats.module';
import { InvitationsModule } from './invitations/invitations.module';
import { CostingModule } from './costing/costing.module';
import { SuperAdminModule } from './super-admin/super-admin.module'; // [新增] 导入SuperAdminModule

@Module({
  imports: [
    // [核心重构] 将 ConfigModule 放在最前面，并设置为全局可用
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    AuthModule,
    TenantsModule,
    RecipesModule,
    IngredientsModule,
    TasksModule,
    MembersModule,
    StatsModule,
    InvitationsModule,
    CostingModule,
    SuperAdminModule, // [新增] 注册SuperAdminModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
