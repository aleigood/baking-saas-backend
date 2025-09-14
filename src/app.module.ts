import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { SuperAdminModule } from './super-admin/super-admin.module';
import { TenantsModule } from './tenants/tenants.module';
import { MembersModule } from './members/members.module';
import { RecipesModule } from './recipes/recipes.module';
import { IngredientsModule } from './ingredients/ingredients.module';
import { CostingModule } from './costing/costing.module';
import { StatsModule } from './stats/stats.module';
import { ProductionTasksModule } from './production-tasks/production-tasks.module';
import { FermentationModule } from './fermentation/fermentation.module';
import { UsersModule } from './users/users.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
    imports: [
        PrismaModule,
        AuthModule,
        SuperAdminModule,
        TenantsModule,
        MembersModule,
        RecipesModule,
        IngredientsModule,
        CostingModule,
        StatsModule,
        ProductionTasksModule,
        FermentationModule,
        UsersModule,
        DashboardModule,
    ],
    controllers: [AppController],
    providers: [AppService],
})
export class AppModule {}
