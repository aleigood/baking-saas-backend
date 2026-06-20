import { PaymentOrderStatus, SubscriptionStatus } from '@prisma/client';
import { BillingService } from './billing.service';

describe('BillingService payment activation', () => {
    const paidAt = new Date('2026-06-20T10:00:00.000Z');
    const currentExpiry = new Date('2026-07-20T10:00:00.000Z');

    function setup(orderStatus: PaymentOrderStatus = PaymentOrderStatus.PENDING) {
        const tx = {
            paymentOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'order-id',
                    orderNo: 'BS1',
                    tenantId: 'tenant-id',
                    planId: 'plan-id',
                    amountInCents: 3900,
                    status: orderStatus,
                    plan: { durationDays: 31 },
                }),
                updateMany: jest.fn().mockResolvedValue({ count: orderStatus === PaymentOrderStatus.PAID ? 0 : 1 }),
                update: jest.fn().mockResolvedValue({}),
            },
            tenantSubscription: {
                findFirst: jest.fn().mockResolvedValue({ expiresAt: currentExpiry }),
                create: jest.fn().mockResolvedValue({ id: 'subscription-id' }),
            },
        };
        const prisma = { $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)) };
        return { service: new BillingService(prisma as any, {} as any), tx };
    }

    it('extends from the latest entitlement end date', async () => {
        const { service, tx } = setup();
        await service.applyWechatTransaction({ out_trade_no: 'BS1', transaction_id: 'wx1', trade_state: 'SUCCESS', success_time: paidAt.toISOString(), amount: { total: 3900 } });

        expect(tx.tenantSubscription.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                startsAt: currentExpiry,
                expiresAt: new Date(currentExpiry.getTime() + 31 * 24 * 60 * 60 * 1000),
                status: SubscriptionStatus.ACTIVE,
                source: 'wechat_pay',
            }),
        });
    });

    it('does not create duplicate entitlement for an already paid order', async () => {
        const { service, tx } = setup(PaymentOrderStatus.PAID);
        await service.applyWechatTransaction({ out_trade_no: 'BS1', trade_state: 'SUCCESS', amount: { total: 3900 } });
        expect(tx.tenantSubscription.create).not.toHaveBeenCalled();
    });
});
