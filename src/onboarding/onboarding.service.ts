import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, JoinLinkStatus, Prisma, TenantStatus } from '@prisma/client';
import { createHash } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { getUserDisplayName } from '../common/utils/user-display.util';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { CreateMembershipApplicationDto } from './dto/create-membership-application.dto';
import { CreateStoreApplicationDto } from './dto/create-store-application.dto';

@Injectable()
export class OnboardingService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly sms: SmsService,
        private readonly auth: AuthService,
    ) {}

    getStoreApplication(userId: string) {
        return this.prisma.storeApplication.findFirst({
            where: { applicantId: userId },
            include: { createdTenant: { select: { id: true, name: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    async createStoreApplication(userId: string, dto: CreateStoreApplicationDto) {
        const profile = await this.prepareProfile(userId, dto);
        const result = await this.prisma.$transaction(async (tx) => {
            const applicantId = await this.saveProfile(tx, profile);
            const pending = await tx.storeApplication.findFirst({
                where: { applicantId, status: ApplicationStatus.PENDING },
                select: { id: true },
            });
            if (pending) throw new ConflictException('您已有待审核的开店申请');
            const application = await tx.storeApplication.create({
                data: {
                    applicantId,
                    storeName: dto.storeName.trim(),
                    address: dto.address.trim(),
                    description: dto.description?.trim() || null,
                    contactName: dto.name,
                    contactPhone: dto.phone,
                    wechatNickname: dto.wechatNickname,
                },
            });
            return { application, applicantId };
        });
        return { ...result.application, ...(await this.auth.refreshLoginResponse(result.applicantId)) };
    }

    async cancelStoreApplication(userId: string, id: string) {
        const updated = await this.prisma.storeApplication.updateMany({
            where: { id, applicantId: userId, status: ApplicationStatus.PENDING },
            data: { status: ApplicationStatus.CANCELED },
        });
        if (!updated.count) throw new NotFoundException('申请不存在或已处理');
        return { canceled: true };
    }

    async getJoinLink(userId: string, token: string) {
        const link = await this.findActiveLink(token);
        const [membership, application] = await Promise.all([
            this.prisma.tenantUser.findUnique({
                where: { userId_tenantId: { userId, tenantId: link.tenantId } },
                select: { role: true },
            }),
            this.prisma.membershipApplication.findUnique({
                where: { tenantId_applicantId: { tenantId: link.tenantId, applicantId: userId } },
                select: { status: true },
            }),
        ]);
        const relationship = membership
            ? membership.role === 'OWNER'
                ? 'OWNER'
                : 'MEMBER'
            : application?.status === ApplicationStatus.PENDING
              ? 'PENDING'
              : application?.status === ApplicationStatus.REJECTED
                ? 'REJECTED'
                : 'AVAILABLE';
        return {
            tenant: { id: link.tenant.id, name: link.tenant.name },
            role: link.role,
            expiresAt: link.expiresAt,
            inviter: getUserDisplayName(link.createdBy),
            relationship,
        };
    }

    async createMembershipApplication(userId: string, dto: CreateMembershipApplicationDto) {
        const link = await this.findActiveLink(dto.token);
        const [membership, pendingApplication] = await Promise.all([
            this.prisma.tenantUser.findUnique({
                where: { userId_tenantId: { userId, tenantId: link.tenantId } },
                select: { userId: true },
            }),
            this.prisma.membershipApplication.findUnique({
                where: { tenantId_applicantId: { tenantId: link.tenantId, applicantId: userId } },
                select: { status: true },
            }),
        ]);
        if (membership) throw new ConflictException('您已经是该店铺成员');
        if (pendingApplication?.status === ApplicationStatus.PENDING) {
            throw new ConflictException('您的申请正在等待店主确认');
        }
        const profile = await this.prepareProfile(userId, dto);
        const result = await this.prisma.$transaction(async (tx) => {
            const applicantId = await this.saveProfile(tx, profile);
            const currentMembership = await tx.tenantUser.findUnique({
                where: { userId_tenantId: { userId: applicantId, tenantId: link.tenantId } },
            });
            if (currentMembership) throw new ConflictException('您已经是该店铺成员');
            const application = await tx.membershipApplication.upsert({
                where: { tenantId_applicantId: { tenantId: link.tenantId, applicantId } },
                update: {
                    joinLinkId: link.id,
                    displayName: dto.name,
                    wechatNickname: dto.wechatNickname,
                    message: dto.message?.trim() || null,
                    status: ApplicationStatus.PENDING,
                    reviewedAt: null,
                    reviewedById: null,
                    reviewNote: null,
                },
                create: {
                    joinLinkId: link.id,
                    tenantId: link.tenantId,
                    applicantId,
                    displayName: dto.name,
                    wechatNickname: dto.wechatNickname,
                    message: dto.message?.trim() || null,
                },
            });
            return { application, applicantId };
        });
        return { ...result.application, ...(await this.auth.refreshLoginResponse(result.applicantId)) };
    }

    listMembershipApplications(userId: string) {
        return this.prisma.membershipApplication.findMany({
            where: { applicantId: userId },
            include: {
                tenant: { select: { id: true, name: true } },
                joinLink: { select: { role: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    private async findActiveLink(token: string) {
        const link = await this.prisma.tenantJoinLink.findUnique({
            where: { tokenHash: createHash('sha256').update(token).digest('hex') },
            include: { tenant: true, createdBy: { select: { name: true, wechatNickname: true } } },
        });
        if (
            !link ||
            link.status !== JoinLinkStatus.ACTIVE ||
            link.expiresAt <= new Date() ||
            link.tenant.status !== TenantStatus.ACTIVE
        )
            throw new NotFoundException('邀请已失效');
        return link;
    }

    private async prepareProfile(
        userId: string,
        dto: { name: string; wechatNickname: string; phone: string; verificationCode?: string },
    ) {
        const current = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!current) throw new NotFoundException('用户不存在');
        const unchangedVerifiedPhone =
            current.profileCompletedAt && current.phone === dto.phone && current.phoneVerifiedAt;
        const challengeId = unchangedVerifiedPhone
            ? undefined
            : dto.verificationCode
              ? await this.sms.verifyRegistrationCode(dto.phone, dto.verificationCode)
              : (() => {
                    throw new BadRequestException('请输入短信验证码');
                })();
        const existing = await this.prisma.user.findUnique({ where: { phone: dto.phone } });
        if (existing && existing.id !== current.id && existing.wechatOpenId) {
            throw new ConflictException('该手机号已绑定其他微信账号');
        }
        return { current, existing: existing?.id === current.id ? null : existing, challengeId, ...dto };
    }

    private async saveProfile(
        tx: Prisma.TransactionClient,
        profile: Awaited<ReturnType<OnboardingService['prepareProfile']>>,
    ): Promise<string> {
        if (profile.challengeId) await this.sms.consumeRegistrationCode(tx, profile.challengeId);
        const now = new Date();
        if (profile.existing) {
            await tx.user.update({
                where: { id: profile.existing.id },
                data: {
                    name: profile.name,
                    wechatNickname: profile.wechatNickname,
                    phoneVerifiedAt: now,
                    profileCompletedAt: now,
                    wechatOpenId: profile.current.wechatOpenId,
                    wechatUnionId: profile.current.wechatUnionId,
                    avatarUrl: profile.current.avatarUrl || profile.existing.avatarUrl,
                },
            });
            await tx.user.delete({ where: { id: profile.current.id } });
            return profile.existing.id;
        }
        await tx.user.update({
            where: { id: profile.current.id },
            data: {
                name: profile.name,
                wechatNickname: profile.wechatNickname,
                phone: profile.phone,
                phoneVerifiedAt: profile.challengeId ? now : profile.current.phoneVerifiedAt,
                profileCompletedAt: now,
            },
        });
        return profile.current.id;
    }
}
