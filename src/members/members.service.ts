import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, JoinLinkStatus, TenantRole, UserStatus } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { EntitlementsService } from '../billing/entitlements.service';
import { getUserDisplayName } from '../common/utils/user-display.util';
import { PrismaService } from '../prisma/prisma.service';
import { CreateJoinLinkDto } from './dto/create-join-link.dto';
import { ReviewMembershipApplicationDto } from './dto/review-membership-application.dto';
import { UpdateMemberDto } from './dto/update-member.dto';

@Injectable()
export class MembersService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly entitlements: EntitlementsService,
    ) {}

    async createJoinLink(user: UserPayload, dto: CreateJoinLinkDto) {
        this.assertOwner(user);
        if (dto.role === TenantRole.OWNER) throw new ForbiddenException('不能邀请店铺所有者');
        const token = randomBytes(32).toString('base64url');
        const link = await this.prisma.tenantJoinLink.create({
            data: {
                tenantId: user.tenantId,
                createdById: user.sub,
                tokenHash: createHash('sha256').update(token).digest('hex'),
                role: dto.role,
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            },
        });
        return { id: link.id, token, role: link.role, expiresAt: link.expiresAt };
    }

    listJoinLinks(user: UserPayload) {
        this.assertOwner(user);
        return this.prisma.tenantJoinLink.findMany({
            where: { tenantId: user.tenantId, status: JoinLinkStatus.ACTIVE, expiresAt: { gt: new Date() } },
            select: { id: true, role: true, expiresAt: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    async revokeJoinLink(user: UserPayload, id: string) {
        this.assertOwner(user);
        const result = await this.prisma.tenantJoinLink.updateMany({
            where: { id, tenantId: user.tenantId },
            data: { status: JoinLinkStatus.REVOKED },
        });
        if (!result.count) throw new NotFoundException('邀请不存在');
        return { revoked: true };
    }

    listApplications(user: UserPayload) {
        this.assertOwner(user);
        return this.prisma.membershipApplication.findMany({
            where: { tenantId: user.tenantId },
            include: {
                applicant: { select: { id: true, name: true, wechatNickname: true, avatarUrl: true } },
                joinLink: { select: { role: true } },
            },
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        });
    }

    async approveApplication(user: UserPayload, id: string, dto: ReviewMembershipApplicationDto) {
        this.assertOwner(user);
        const application = await this.prisma.membershipApplication.findFirst({
            where: { id, tenantId: user.tenantId, status: ApplicationStatus.PENDING },
            include: { joinLink: true },
        });
        if (!application) throw new NotFoundException('申请不存在或已处理');
        const existingMembership = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { userId: application.applicantId, tenantId: user.tenantId } },
            select: { userId: true },
        });
        if (existingMembership) {
            const closed = await this.prisma.membershipApplication.updateMany({
                where: { id: application.id, status: ApplicationStatus.PENDING },
                data: {
                    status: ApplicationStatus.CANCELED,
                    reviewedById: user.sub,
                    reviewedAt: new Date(),
                    reviewNote: '申请人已是店铺成员，申请已自动关闭',
                },
            });
            if (!closed.count) throw new ConflictException('该申请已经被处理');
            return { approved: false, alreadyMember: true };
        }
        await this.entitlements.assertCanInviteMember(user.tenantId);
        return this.prisma.$transaction(async (tx) => {
            const updated = await tx.membershipApplication.updateMany({
                where: { id, status: ApplicationStatus.PENDING },
                data: {
                    status: ApplicationStatus.APPROVED,
                    reviewedById: user.sub,
                    reviewedAt: new Date(),
                    reviewNote: dto.reviewNote?.trim() || null,
                },
            });
            if (!updated.count) throw new ConflictException('该申请已经被处理');
            await tx.tenantUser.create({
                data: {
                    userId: application.applicantId,
                    tenantId: user.tenantId,
                    role: application.joinLink.role,
                    status: UserStatus.ACTIVE,
                },
            });
            return { approved: true };
        });
    }

    async rejectApplication(user: UserPayload, id: string, dto: ReviewMembershipApplicationDto) {
        this.assertOwner(user);
        const result = await this.prisma.membershipApplication.updateMany({
            where: { id, tenantId: user.tenantId, status: ApplicationStatus.PENDING },
            data: {
                status: ApplicationStatus.REJECTED,
                reviewedById: user.sub,
                reviewedAt: new Date(),
                reviewNote: dto.reviewNote?.trim() || null,
            },
        });
        if (!result.count) throw new NotFoundException('申请不存在或已处理');
        return { rejected: true };
    }

    async findAllInAllTenantsByOwner(ownerId: string) {
        const tenants = await this.prisma.tenant.findMany({
            where: { members: { some: { userId: ownerId, role: TenantRole.OWNER } } },
            include: { members: { include: { user: true }, orderBy: { user: { createdAt: 'asc' } } } },
        });
        return tenants.map((tenant) => ({
            tenantId: tenant.id,
            tenantName: tenant.name,
            members: tenant.members.map((tu) => this.formatMember(tu)),
        }));
    }

    async resolveTenantId(user: UserPayload, requestedTenantId?: string) {
        if (!requestedTenantId || requestedTenantId === user.tenantId) return user.tenantId;
        if (user.tenantRole !== TenantRole.OWNER) throw new ForbiddenException('无权访问该店铺');
        const ownership = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { userId: user.sub, tenantId: requestedTenantId } },
        });
        if (ownership?.role !== TenantRole.OWNER) throw new ForbiddenException('无权访问该店铺');
        return requestedTenantId;
    }

    async findAll(tenantId: string) {
        const rows = await this.prisma.tenantUser.findMany({
            where: { tenantId },
            include: { user: true },
            orderBy: { user: { createdAt: 'asc' } },
        });
        return rows.map((row) => this.formatMember(row));
    }

    async findOne(tenantId: string, memberId: string) {
        const row = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { tenantId, userId: memberId } },
            include: { user: true },
        });
        if (!row) throw new NotFoundException('该成员不存在');
        return this.formatMember(row);
    }

    async update(tenantId: string, memberId: string, dto: UpdateMemberDto, user: UserPayload) {
        const target = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { tenantId, userId: memberId } },
        });
        if (!target) throw new NotFoundException('该成员不存在');
        if (
            user.tenantRole === TenantRole.MEMBER ||
            dto.role === TenantRole.OWNER ||
            (user.tenantRole === TenantRole.ADMIN && target.role !== TenantRole.MEMBER)
        )
            throw new ForbiddenException('无权修改该成员');
        return this.prisma.tenantUser.update({
            where: { userId_tenantId: { tenantId, userId: memberId } },
            data: { role: dto.role, status: dto.status },
        });
    }

    async remove(tenantId: string, memberId: string, user: UserPayload) {
        const target = await this.prisma.tenantUser.findUnique({
            where: { userId_tenantId: { tenantId, userId: memberId } },
        });
        if (!target) throw new NotFoundException('该成员不存在');
        if (
            target.role === TenantRole.OWNER ||
            user.tenantRole === TenantRole.MEMBER ||
            (user.tenantRole === TenantRole.ADMIN && target.role !== TenantRole.MEMBER)
        )
            throw new ForbiddenException('无权移除该成员');
        return this.prisma.tenantUser.delete({ where: { userId_tenantId: { tenantId, userId: memberId } } });
    }

    private assertOwner(user: UserPayload) {
        if (user.tenantRole !== TenantRole.OWNER) throw new ForbiddenException('仅店铺所有者可执行此操作');
    }
    private formatMember(row: {
        role: TenantRole;
        status: UserStatus;
        user: {
            id: string;
            name: string | null;
            wechatNickname: string | null;
            avatarUrl: string | null;
            createdAt: Date;
        };
    }) {
        return {
            id: row.user.id,
            name: row.user.name,
            wechatNickname: row.user.wechatNickname,
            displayName: getUserDisplayName(row.user),
            avatarUrl: row.user.avatarUrl,
            role: row.role,
            status: row.status,
            joinDate: row.user.createdAt.toISOString().split('T')[0],
        };
    }
}
