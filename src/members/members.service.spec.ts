import { ApplicationStatus, GlobalRole, TenantRole } from '@prisma/client';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { EntitlementsService } from '../billing/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

describe('MembersService membership application safety', () => {
    const owner: UserPayload = {
        sub: 'owner-1',
        tenantId: 'tenant-1',
        tenantRole: TenantRole.OWNER,
        globalRole: GlobalRole.USER,
        iat: 0,
        exp: 0,
    };

    it('closes a stale application without overwriting an existing member role', async () => {
        const updateMany = jest.fn().mockResolvedValue({ count: 1 });
        const prisma = {
            membershipApplication: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'application-1',
                    applicantId: 'member-1',
                    joinLink: { role: TenantRole.ADMIN },
                }),
                updateMany,
            },
            tenantUser: {
                findUnique: jest.fn().mockResolvedValue({ userId: 'member-1' }),
                create: jest.fn(),
            },
        } as unknown as PrismaService;
        const entitlements = { assertCanInviteMember: jest.fn() } as unknown as EntitlementsService;
        const service = new MembersService(prisma, entitlements);

        await expect(service.approveApplication(owner, 'application-1', {})).resolves.toEqual({
            approved: false,
            alreadyMember: true,
        });
        expect(updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'application-1', status: ApplicationStatus.PENDING },
                data: expect.objectContaining({ status: ApplicationStatus.CANCELED }),
            }),
        );
        expect(entitlements.assertCanInviteMember).not.toHaveBeenCalled();
        expect((prisma as any).tenantUser.create).not.toHaveBeenCalled();
    });
});
