/**
 * 文件路径: src/invitations/invitations.service.ts
 * 文件描述: 邀请功能的核心业务逻辑。
 */
import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Role } from '@prisma/client';
import { randomBytes } from 'crypto';

@Injectable()
export class InvitationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * 创建一个新的邀请码
   * @param currentUser 发起邀请的用户
   */
  async create(currentUser: UserPayload) {
    // 权限校验：只有老板和主管可以创建邀请
    if (currentUser.role === Role.BAKER) {
      throw new ForbiddenException('Bakers cannot create invitations.');
    }

    const code = randomBytes(8).toString('hex'); // 生成一个16位的随机码
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24小时后过期

    const invitation = await this.prisma.invitation.create({
      data: {
        code,
        expiresAt,
        tenantId: currentUser.tenantId,
        creatorId: currentUser.userId,
      },
    });

    return {
      invitationCode: invitation.code,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * 验证邀请码的有效性
   * @param code 邀请码
   * @returns 返回邀请信息，如果无效则返回 null
   */
  async validate(code: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { code },
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      return null; // 邀请码不存在或已过期
    }

    return invitation;
  }
}
