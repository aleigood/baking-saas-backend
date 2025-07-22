/**
 * 文件路径: src/invitations/invitations.module.ts
 * 文件描述: 邀请功能模块。
 */
import { Module } from '@nestjs/common';
import { InvitationsService } from './invitations.service';
import { InvitationsController } from './invitations.controller';

@Module({
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService], // 导出服务，以便Auth模块可以使用
})
export class InvitationsModule {}
