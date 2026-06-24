import { PaymentOrderStatus, SubscriptionStatus, TenantRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';
import { EntitlementsService } from './entitlements.service';
import { WechatPayService } from './wechat-pay.service';

describe('BillingService payment activation', () => {
    const paidAt = new Date('2026-06-20T10:00:00.000Z');
    const currentExpiry = new Date('2026-07-20T10:00:00.000Z');
    const entitlements = {
        getDefaultPolicyForTier: jest.fn().mockResolvedValue({ id: 'policy-id' }),
    } as unknown as EntitlementsService;

    function setup(orderStatus: PaymentOrderStatus = PaymentOrderStatus.PENDING) {
        const tx = {
            paymentOrder: {
                findUnique: jest.fn().mockResolvedValue({
                    id: 'order-id',
                    orderNo: 'BS1',
                    tenantId: 'tenant-id',
                    planId: 'plan-id',
                    entitlementPolicyId: 'policy-id',
                    amountInCents: 3900,
                    status: orderStatus,
                    plan: { durationDays: 31 },
                    tenant: { trialEndsAt: null },
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
        return {
            service: new BillingService(
                prisma as unknown as PrismaService,
                {} as unknown as WechatPayService,
                entitlements,
            ),
            tx,
        };
    }

    it('extends from the latest entitlement end date', async () => {
        const { service, tx } = setup();
        await service.applyWechatTransaction({
            out_trade_no: 'BS1',
            transaction_id: 'wx1',
            trade_state: 'SUCCESS',
            success_time: paidAt.toISOString(),
            amount: { total: 3900 },
        });

        expect(tx.tenantSubscription.create).toHaveBeenCalledWith({
            data: {
                tenantId: 'tenant-id',
                planId: 'plan-id',
                entitlementPolicyId: 'policy-id',
                startsAt: currentExpiry,
                expiresAt: new Date(currentExpiry.getTime() + 31 * 24 * 60 * 60 * 1000),
                status: SubscriptionStatus.ACTIVE,
                source: 'wechat_pay',
            },
        });
    });

    it('does not create duplicate entitlement for an already paid order', async () => {
        const { service, tx } = setup(PaymentOrderStatus.PAID);
        await service.applyWechatTransaction({ out_trade_no: 'BS1', trade_state: 'SUCCESS', amount: { total: 3900 } });
        expect(tx.tenantSubscription.create).not.toHaveBeenCalled();
    });

    it('completes a development mock order through the normal activation handler', async () => {
        const prisma = {
            subscriptionPlan: {
                findFirst: jest.fn().mockResolvedValue({ id: 'plan-id', name: '1个月', priceInCents: 3900 }),
            },
            user: { findUnique: jest.fn().mockResolvedValue({ wechatOpenId: null }) },
            paymentOrder: { create: jest.fn().mockResolvedValue({ id: 'order-id' }), update: jest.fn() },
        };
        const wechatPay = { isMockMode: jest.fn().mockReturnValue(true) };
        const service = new BillingService(
            prisma as unknown as PrismaService,
            wechatPay as unknown as WechatPayService,
            entitlements,
        );
        const activate = jest.spyOn(service, 'applyWechatTransaction').mockResolvedValue(undefined);

        const result = await service.createOrder('user-id', 'tenant-id', TenantRole.OWNER, 'plan-id');

        expect(result.mockPaid).toBe(true);
        expect(result.paymentParams).toBeNull();
        expect(activate).toHaveBeenCalledWith(
            expect.objectContaining({ trade_state: 'SUCCESS', amount: { total: 3900 } }),
        );
    });
});
