import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateMembershipApplicationDto } from './dto/create-membership-application.dto';
import { CreateStoreApplicationDto } from './dto/create-store-application.dto';
import { OnboardingService } from './onboarding.service';

@UseGuards(AuthGuard('jwt'))
@Controller('onboarding')
export class OnboardingController {
    constructor(private readonly onboardingService: OnboardingService) {}

    @Get('store-application')
    getStoreApplication(@GetUser() user: UserPayload) {
        return this.onboardingService.getStoreApplication(user.sub);
    }

    @Post('store-applications')
    createStoreApplication(@GetUser() user: UserPayload, @Body() dto: CreateStoreApplicationDto) {
        return this.onboardingService.createStoreApplication(user.sub, dto);
    }

    @Post('store-applications/:id/cancel')
    cancelStoreApplication(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) {
        return this.onboardingService.cancelStoreApplication(user.sub, id);
    }

    @Get('join-link')
    getJoinLink(@GetUser() user: UserPayload, @Query('token') token: string) {
        return this.onboardingService.getJoinLink(user.sub, token);
    }

    @Post('membership-applications')
    createMembershipApplication(@GetUser() user: UserPayload, @Body() dto: CreateMembershipApplicationDto) {
        return this.onboardingService.createMembershipApplication(user.sub, dto);
    }

    @Get('membership-applications/mine')
    listMembershipApplications(@GetUser() user: UserPayload) {
        return this.onboardingService.listMembershipApplications(user.sub);
    }
}
