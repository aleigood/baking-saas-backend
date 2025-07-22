/**
 * 文件路径: src/invitations/invitations.controller.ts
 * 文件描述: 处理创建邀请码的API请求。
 */
import { Controller, Post, UseGuards } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { AuthGuard } from '@nestjs/passport';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';

@UseGuards(AuthGuard('jwt'))
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Post()
  create(@GetUser() user: UserPayload) {
    return this.invitationsService.create(user);
  }
}
