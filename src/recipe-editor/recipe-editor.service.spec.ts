import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { RecipeEditorSessionStatus, TenantRole } from '@prisma/client';

jest.mock('../ingredients/ingredients.service', () => ({ IngredientsService: class IngredientsService {} }));

import { RecipeEditorService } from './recipe-editor.service';

describe('RecipeEditorService session leases', () => {
    const findFirst = jest.fn();
    const update = jest.fn();
    const updateMany = jest.fn();
    const transaction = jest.fn((callback: (tx: unknown) => unknown) =>
        callback({ recipeEditorSession: { findFirst, update, updateMany } }),
    );
    const service = new RecipeEditorService(
        {
            recipeEditorSession: { findFirst, update, updateMany },
            $transaction: transaction,
        } as never,
        {} as never,
        {} as never,
    );

    beforeEach(() => {
        findFirst.mockReset();
        update.mockReset();
        updateMany.mockReset();
        transaction.mockClear();
    });

    it('rotates a one-time URL token before editor access', async () => {
        findFirst.mockResolvedValue({
            id: 'session-1',
            token: 'url-token',
            status: RecipeEditorSessionStatus.APPROVED,
            tenantId: 'tenant-1',
            userId: 'user-1',
            actorRole: 'USER',
            tenantRole: TenantRole.OWNER,
            expiresAt: new Date(Date.now() + 60000),
        });
        update.mockImplementation(({ data }: { data: { token: string; expiresAt: Date } }) => ({
            id: 'session-1',
            token: data.token,
            expiresAt: data.expiresAt,
        }));

        const result = await service.exchangeSessionToken('session-1', 'url-token');

        expect(result.token).not.toBe('url-token');
        expect(result.token).toHaveLength(48);
        expect(result.expiresAt).toBeInstanceOf(Date);
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('rejects missing editor credentials before querying', async () => {
        await expect(service.heartbeat('', '')).rejects.toBeInstanceOf(UnauthorizedException);
        expect(findFirst).not.toHaveBeenCalled();
    });

    it('does not approve a second editor for the same tenant', async () => {
        findFirst
            .mockResolvedValueOnce({
                id: 'pending-session',
                token: 'pending-token',
                status: RecipeEditorSessionStatus.PENDING,
                expiresAt: new Date(Date.now() + 60000),
            })
            .mockResolvedValueOnce({ id: 'active-session' });
        updateMany.mockResolvedValue({ count: 0 });

        await expect(
            service.approveSession('pending-session', 'pending-token', 'user-2', 'tenant-1', TenantRole.OWNER),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(update).not.toHaveBeenCalled();
    });
});
