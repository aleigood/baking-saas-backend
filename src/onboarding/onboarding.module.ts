import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TenantsModule } from '../tenants/tenants.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

@Module({
    imports: [AuthModule, TenantsModule],
    controllers: [OnboardingController],
    providers: [OnboardingService],
})
export class OnboardingModule {}
