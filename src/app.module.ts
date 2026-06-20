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
import { BillingModule } from './billing/billing.module';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditInterceptor } from './audit/audit.interceptor';

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
        BillingModule,
    ],
    controllers: [AppController],
    providers: [AppService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AppModule {}
