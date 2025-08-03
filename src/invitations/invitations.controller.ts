import { Controller, Post, Body, UseGuards, Param } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { IsNotEmpty, IsString } from 'class-validator';

// 修复：创建一个新的DTO，使用 phone 代替 email
export class CreateInvitationDto {
    @IsString()
    @IsNotEmpty()
    phone: string;
}

@UseGuards(AuthGuard('jwt'))
@Controller('invitations')
export class InvitationsController {
    constructor(private readonly invitationsService: InvitationsService) {}

    @Post()
    create(@GetUser() user: UserPayload, @Body() createInvitationDto: CreateInvitationDto) {
        // 修复：调用 service 时传递 phone
        return this.invitationsService.create(user.tenantId, createInvitationDto.phone, user);
    }

    @Post(':id/accept')
    accept(@GetUser() user: UserPayload, @Param('id') id: string) {
        return this.invitationsService.accept(id, user);
    }
}
