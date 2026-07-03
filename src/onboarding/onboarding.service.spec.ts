import { ConflictException } from '@nestjs/common';
import { ApplicationStatus, TenantRole } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { OnboardingService } from './onboarding.service';

describe('OnboardingService membership application identity', () => {
    const activeLink = {
        id: 'link-2',
        tenantId: 'tenant-1',
        role: TenantRole.MEMBER,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 60_000),
        tenant: { id: 'tenant-1', name: '测试店铺', status: 'ACTIVE' },
        createdBy: { name: '店主', wechatNickname: null },
    };

    const createService = (membership: unknown, application: unknown = null) => {
        const prisma = {
            tenantJoinLink: { findUnique: jest.fn().mockResolvedValue(activeLink) },
            tenantUser: { findUnique: jest.fn().mockResolvedValue(membership) },
            membershipApplication: { findUnique: jest.fn().mockResolvedValue(application) },
        } as unknown as PrismaService;
        return { service: new OnboardingService(prisma, {} as SmsService, {} as AuthService), prisma };
    };

    it('rejects a new application when the user already belongs to the target tenant', async () => {
        const { service } = createService({ userId: 'user-1' });

        await expect(
            service.createMembershipApplication('user-1', {
                token: 'token',
                name: '员工',
                wechatNickname: '员工昵称',
                phone: '13800000000',
            }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('resolves pending state by tenant even when the user opens a different link', async () => {
        const { service, prisma } = createService(null, { status: ApplicationStatus.PENDING });

        await expect(service.getJoinLink('user-1', 'token')).resolves.toEqual(
            expect.objectContaining({ relationship: 'PENDING' }),
        );
        expect((prisma as any).membershipApplication.findUnique).toHaveBeenCalledWith({
            where: { tenantId_applicantId: { tenantId: 'tenant-1', applicantId: 'user-1' } },
            select: { status: true },
        });
    });
});
