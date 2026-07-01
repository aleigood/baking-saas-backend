import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { GlobalRole, TenantRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { AuthService } from './auth.service';

describe('AuthService WeChat tenant context', () => {
    const createService = (membership: unknown) => {
        const prisma = {
            tenantUser: { findFirst: jest.fn().mockResolvedValue(membership) },
        } as unknown as PrismaService;
        const sign = jest.fn((payload: object) => JSON.stringify(payload));
        const jwt = { sign } as unknown as JwtService;
        const service = new AuthService(prisma, jwt, {} as SmsService, {} as ConfigService);
        return { service, sign };
    };

    it('uses a tenant membership for WeChat login even when the user is a super administrator', async () => {
        const { service, sign } = createService({
            tenantId: 'tenant-1',
            role: TenantRole.OWNER,
            tenant: { id: 'tenant-1' },
        });

        const result = await (
            service as unknown as {
                buildLoginResponse(
                    userId: string,
                    role: GlobalRole,
                ): Promise<{ accessToken: string; redirectTo?: string }>;
            }
        ).buildLoginResponse('user-1', GlobalRole.SUPER_ADMIN);

        expect(sign).toHaveBeenCalledWith(
            expect.objectContaining({ tenantId: 'tenant-1', tenantRole: TenantRole.OWNER }),
        );
        expect(result.redirectTo).toBeUndefined();
    });

    it('keeps a tenantless WeChat user on the store access page', async () => {
        const { service, sign } = createService(null);

        const result = await (
            service as unknown as {
                buildLoginResponse(
                    userId: string,
                    role: GlobalRole,
                ): Promise<{ accessToken: string; redirectTo?: string }>;
            }
        ).buildLoginResponse('user-1', GlobalRole.SUPER_ADMIN);

        expect(sign).toHaveBeenCalledWith(expect.objectContaining({ tenantId: '' }));
        expect(result.redirectTo).toBe('/pages/onboarding/store-access');
    });

    it('rejects an identity when openid and unionid point to different local users', async () => {
        const prisma = {
            user: { findMany: jest.fn().mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }]) },
        } as unknown as PrismaService;
        const service = new AuthService(prisma, {} as JwtService, {} as SmsService, {} as ConfigService);

        await expect(
            (
                service as unknown as {
                    findWechatUser(identity: { openid: string; unionid: string }): Promise<unknown>;
                }
            ).findWechatUser({ openid: 'openid-1', unionid: 'unionid-1' }),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not issue a tenant token for an inactive membership', async () => {
        const prisma = {
            tenantUser: {
                findUnique: jest.fn().mockResolvedValue({
                    status: UserStatus.INACTIVE,
                    role: TenantRole.MEMBER,
                    user: { status: UserStatus.ACTIVE, globalRole: GlobalRole.USER },
                    tenant: { status: 'ACTIVE' },
                }),
            },
        } as unknown as PrismaService;
        const sign = jest.fn();
        const jwt = { sign } as unknown as JwtService;
        const service = new AuthService(prisma, jwt, {} as SmsService, {} as ConfigService);

        await expect(service.switchTenant('user-1', 'tenant-1')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(sign).not.toHaveBeenCalled();
    });
});
