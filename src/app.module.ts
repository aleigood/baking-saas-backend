import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SuperAdminModule } from './super-admin/super-admin.module';
import { TenantsModule } from './tenants/tenants.module';
import { MembersModule } from './members/members.module';
import { InvitationsModule } from './invitations/invitations.module';
import { RecipesModule } from './recipes/recipes.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { CostingModule } from './costing/costing.module';
import { StatsModule } from './stats/stats.module';
import { ProductionTasksModule } from './production-tasks/production-tasks.module';
import { FermentationModule } from './fermentation/fermentation.module'; // [核心新增] 导入新模块

@Module({
    imports: [
        PrismaModule,
        AuthModule,
        SuperAdminModule,
        TenantsModule,
        MembersModule,
        InvitationsModule,
        RecipesModule,
        IngredientsModule,
        CostingModule,
        StatsModule,
        ProductionTasksModule,
        FermentationModule, // [核心新增] 注册新模块
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
