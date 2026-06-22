import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InvitationStatus, TenantStatus, UserStatus } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { TenantsService } from '../tenants/tenants.service';

@Injectable()
export class OnboardingService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly tenantsService: TenantsService,
        private readonly authService: AuthService,
    ) {}

    async listInvitations(userId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
        if (!user) throw new NotFoundException('用户不存在');
        return this.prisma.invitation.findMany({
            where: {
                phone: user.phone,
                status: InvitationStatus.PENDING,
                expiresAt: { gt: new Date() },
                tenant: { status: TenantStatus.ACTIVE },
            },
            select: { id: true, role: true, expiresAt: true, tenant: { select: { id: true, name: true } } },
            orderBy: { expiresAt: 'asc' },
        });
    }

    async createTenant(userId: string, name: string) {
        const tenant = await this.tenantsService.create(userId, { name: name.trim() });
        const token = await this.authService.switchTenant(userId, tenant.id);
        return { tenant, ...token, role: 'OWNER' as const };
    }

    async acceptInvitation(userId: string, invitationId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
        if (!user) throw new NotFoundException('用户不存在');
        const invitation = await this.prisma.invitation.findFirst({
            where: {
                id: invitationId,
                phone: user.phone,
                status: InvitationStatus.PENDING,
                expiresAt: { gt: new Date() },
                tenant: { status: TenantStatus.ACTIVE },
            },
        });
        if (!invitation) throw new NotFoundException('邀请不存在、已过期或不属于当前手机号');

        await this.prisma.$transaction(async (tx) => {
            const accepted = await tx.invitation.updateMany({
                where: { id: invitation.id, status: InvitationStatus.PENDING },
                data: { status: InvitationStatus.ACCEPTED },
            });
            if (accepted.count !== 1) throw new ConflictException('该邀请已经被处理');
            await tx.tenantUser.upsert({
                where: { userId_tenantId: { userId, tenantId: invitation.tenantId } },
                update: { role: invitation.role, status: UserStatus.ACTIVE },
                create: { userId, tenantId: invitation.tenantId, role: invitation.role, status: UserStatus.ACTIVE },
            });
        });

        return { ...(await this.authService.switchTenant(userId, invitation.tenantId)), role: invitation.role };
    }
}
