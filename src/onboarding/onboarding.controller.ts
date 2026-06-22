import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateOnboardingTenantDto } from './dto/create-onboarding-tenant.dto';
import { OnboardingService } from './onboarding.service';

@UseGuards(AuthGuard('jwt'))
@Controller('onboarding')
export class OnboardingController {
    constructor(private readonly onboardingService: OnboardingService) {}

    @Get('invitations')
    listInvitations(@GetUser() user: UserPayload) {
        return this.onboardingService.listInvitations(user.sub);
    }

    @Post('tenant')
    createTenant(@GetUser() user: UserPayload, @Body() dto: CreateOnboardingTenantDto) {
        return this.onboardingService.createTenant(user.sub, dto.name);
    }

    @Post('invitations/:id/accept')
    acceptInvitation(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) {
        return this.onboardingService.acceptInvitation(user.sub, id);
    }
}
