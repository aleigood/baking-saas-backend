import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TenantRole } from '@prisma/client';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { CreateJoinLinkDto } from './dto/create-join-link.dto';
import { ReviewMembershipApplicationDto } from './dto/review-membership-application.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

@UseGuards(AuthGuard('jwt'))
@Controller('members')
export class MembersController {
    constructor(private readonly service: MembersService) {}
    @Post('join-links') createJoinLink(@GetUser() user: UserPayload, @Body() dto: CreateJoinLinkDto) { return this.service.createJoinLink(user, dto); }
    @Get('join-links') listJoinLinks(@GetUser() user: UserPayload) { return this.service.listJoinLinks(user); }
    @Patch('join-links/:id/revoke') revokeJoinLink(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) { return this.service.revokeJoinLink(user, id); }
    @Get('applications') listApplications(@GetUser() user: UserPayload) { return this.service.listApplications(user); }
    @Post('applications/:id/approve') approve(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewMembershipApplicationDto) { return this.service.approveApplication(user, id, dto); }
    @Post('applications/:id/reject') reject(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviewMembershipApplicationDto) { return this.service.rejectApplication(user, id, dto); }
    @Get('all-by-owner') findAllByOwner(@GetUser() user: UserPayload) { if (user.tenantRole !== TenantRole.OWNER) throw new ForbiddenException('仅店铺所有者可访问'); return this.service.findAllInAllTenantsByOwner(user.sub); }
    @Get() async findAll(@GetUser() user: UserPayload, @Query('tenantId') tenantId?: string) { return this.service.findAll(await this.service.resolveTenantId(user, tenantId)); }
    @Get(':id') findOne(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) { return this.service.findOne(user.tenantId, id); }
    @Patch(':id') update(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) { return this.service.update(user.tenantId, id, dto, user); }
    @Delete(':id') remove(@GetUser() user: UserPayload, @Param('id', ParseUUIDPipe) id: string) { return this.service.remove(user.tenantId, id, user); }
}
