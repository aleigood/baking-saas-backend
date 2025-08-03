import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { Role, InvitationStatus, UserStatus } from '@prisma/client'; // 修复：导入 UserStatus 枚举

@Injectable()
export class InvitationsService {
    constructor(private prisma: PrismaService) {}

    async create(tenantId: string, phone: string, currentUser: UserPayload) {
        if (currentUser.role === Role.MEMBER) {
            throw new ForbiddenException('只有管理员或所有者才能发送邀请。');
        }

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 邀请7天后过期

        const invitation = await this.prisma.invitation.create({
            data: {
                tenantId,
                phone,
                role: Role.MEMBER, // 新邀请的用户默认为 MEMBER 角色
                expiresAt,
            },
        });

        return {
            message: '邀请已发送',
            invitationId: invitation.id,
        };
    }

    async accept(invitationId: string, user: UserPayload) {
        const invitation = await this.prisma.invitation.findUnique({
            where: { id: invitationId },
        });

        if (!invitation || invitation.status !== InvitationStatus.PENDING || invitation.expiresAt < new Date()) {
            throw new NotFoundException('邀请无效或已过期。');
        }

        // 在事务中更新邀请状态并创建租户成员关系
        return this.prisma.$transaction(async (tx) => {
            await tx.invitation.update({
                where: { id: invitationId },
                data: { status: InvitationStatus.ACCEPTED },
            });

            return tx.tenantUser.create({
                data: {
                    tenantId: invitation.tenantId,
                    userId: user.sub,
                    role: invitation.role,
                    status: UserStatus.ACTIVE, // 修复：现在 UserStatus 已被正确导入
                },
            });
        });
    }
}
