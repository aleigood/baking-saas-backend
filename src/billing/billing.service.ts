import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentOrderStatus, PaymentRefundStatus, Prisma, Role, SubscriptionStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { WechatPayService } from './wechat-pay.service';

interface WechatTransaction {
    out_trade_no: string;
    transaction_id?: string;
    trade_state: string;
    trade_state_desc?: string;
    success_time?: string;
    amount?: { total: number; payer_total?: number; currency?: string };
}

@Injectable()
export class BillingService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly wechatPay: WechatPayService,
    ) {}

    listPlans() {
        return this.prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { durationDays: 'asc' }] });
    }

    async getSubscription(tenantId: string) {
        const now = new Date();
        await this.prisma.tenantSubscription.updateMany({
            where: { tenantId, status: SubscriptionStatus.ACTIVE, expiresAt: { lte: now } },
            data: { status: SubscriptionStatus.EXPIRED },
        });
        const subscriptions = await this.prisma.tenantSubscription.findMany({
            where: { tenantId, status: SubscriptionStatus.ACTIVE, expiresAt: { gt: now } },
            include: { plan: true },
            orderBy: { expiresAt: 'desc' },
        });
        const current = subscriptions.find((item) => item.startsAt <= now) || null;
        const latest = subscriptions[0] || null;
        return { active: Boolean(current), current, entitledUntil: latest?.expiresAt || null };
    }

    async createOrder(userId: string, tenantId: string, role: Role, planId: string) {
        if (role !== Role.OWNER) throw new ForbiddenException('只有店主可以购买或续订套餐');
        const [plan, user] = await Promise.all([
            this.prisma.subscriptionPlan.findFirst({ where: { id: planId, isActive: true } }),
            this.prisma.user.findUnique({ where: { id: userId }, select: { wechatOpenId: true } }),
        ]);
        if (!plan) throw new NotFoundException('套餐不存在或已下架');
        if (!user?.wechatOpenId) throw new BadRequestException('WECHAT_BINDING_REQUIRED');

        const orderNo = this.generateNo('BS');
        const order = await this.prisma.paymentOrder.create({
            data: { orderNo, tenantId, userId, planId, amountInCents: plan.priceInCents, status: PaymentOrderStatus.PENDING },
        });
        try {
            const payment = await this.wechatPay.createJsapiOrder({
                orderNo,
                amountInCents: plan.priceInCents,
                description: `烘焙SaaS-${plan.name}`,
                openId: user.wechatOpenId,
            });
            await this.prisma.paymentOrder.update({ where: { id: order.id }, data: { prepayId: payment.prepayId } });
            return { orderNo, amountInCents: plan.priceInCents, paymentParams: payment.paymentParams };
        } catch (error) {
            await this.prisma.paymentOrder.update({
                where: { id: order.id },
                data: { status: PaymentOrderStatus.FAILED, failureReason: error instanceof Error ? error.message.slice(0, 500) : '微信下单失败' },
            });
            throw error;
        }
    }

    async getOrder(tenantId: string, orderNo: string) {
        const order = await this.prisma.paymentOrder.findFirst({
            where: { tenantId, orderNo },
            include: { plan: true, subscription: true, refunds: { orderBy: { createdAt: 'desc' } } },
        });
        if (!order) throw new NotFoundException('支付订单不存在');
        return order;
    }

    async syncOrder(tenantId: string, orderNo: string) {
        const order = await this.getOrder(tenantId, orderNo);
        if (order.status === PaymentOrderStatus.PAID || order.status === PaymentOrderStatus.REFUNDED) return order;
        const transaction = (await this.wechatPay.queryOrder(orderNo)) as WechatTransaction;
        await this.applyWechatTransaction(transaction);
        return this.getOrder(tenantId, orderNo);
    }

    async syncOrderById(orderId: string) {
        const order = await this.prisma.paymentOrder.findUnique({ where: { id: orderId } });
        if (!order) throw new NotFoundException('支付订单不存在');
        return this.syncOrder(order.tenantId, order.orderNo);
    }

    async handlePaymentNotification(headers: Record<string, string | string[] | undefined>, rawBody: string) {
        const timestamp = this.header(headers, 'wechatpay-timestamp');
        const nonce = this.header(headers, 'wechatpay-nonce');
        const signature = this.header(headers, 'wechatpay-signature');
        this.wechatPay.verifyNotification(timestamp, nonce, signature, rawBody);
        const envelope = JSON.parse(rawBody) as { resource: any };
        const transaction = this.wechatPay.decryptNotification<WechatTransaction>(envelope.resource);
        await this.applyWechatTransaction(transaction);
        return { code: 'SUCCESS', message: '成功' };
    }

    async applyWechatTransaction(transaction: WechatTransaction) {
        if (transaction.trade_state !== 'SUCCESS') {
            if (transaction.trade_state === 'CLOSED' || transaction.trade_state === 'REVOKED') {
                await this.prisma.paymentOrder.updateMany({
                    where: { orderNo: transaction.out_trade_no, status: PaymentOrderStatus.PENDING },
                    data: { status: PaymentOrderStatus.CLOSED, closedAt: new Date(), lastSyncedAt: new Date() },
                });
            }
            return;
        }

        await this.prisma.$transaction(async (tx) => {
            const order = await tx.paymentOrder.findUnique({ where: { orderNo: transaction.out_trade_no }, include: { plan: true } });
            if (!order) throw new NotFoundException('回调对应订单不存在');
            if (order.status === PaymentOrderStatus.PAID || order.status === PaymentOrderStatus.REFUNDED) return;
            if (transaction.amount?.total !== order.amountInCents) throw new BadRequestException('微信支付金额与订单金额不一致');

            const claimed = await tx.paymentOrder.updateMany({
                where: { id: order.id, status: { notIn: [PaymentOrderStatus.PAID, PaymentOrderStatus.REFUNDED] } },
                data: {
                    status: PaymentOrderStatus.PAID,
                    transactionId: transaction.transaction_id,
                    paidAt: transaction.success_time ? new Date(transaction.success_time) : new Date(),
                    lastSyncedAt: new Date(),
                    failureReason: null,
                },
            });
            if (claimed.count === 0) return;

            const now = new Date();
            const latest = await tx.tenantSubscription.findFirst({
                where: { tenantId: order.tenantId, status: SubscriptionStatus.ACTIVE, expiresAt: { gt: now } },
                orderBy: { expiresAt: 'desc' },
            });
            const startsAt = latest?.expiresAt && latest.expiresAt > now ? latest.expiresAt : now;
            const expiresAt = new Date(startsAt.getTime() + order.plan.durationDays * 24 * 60 * 60 * 1000);
            const subscription = await tx.tenantSubscription.create({
                data: { tenantId: order.tenantId, planId: order.planId, startsAt, expiresAt, status: SubscriptionStatus.ACTIVE, source: 'wechat_pay' },
            });
            await tx.paymentOrder.update({ where: { id: order.id }, data: { subscriptionId: subscription.id } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }

    async createRefund(orderId: string, amountInCents: number, reason?: string) {
        const order = await this.prisma.paymentOrder.findUnique({ where: { id: orderId }, include: { subscription: true } });
        if (!order) throw new NotFoundException('订单不存在');
        if (order.status !== PaymentOrderStatus.PAID && order.status !== PaymentOrderStatus.PARTIALLY_REFUNDED) throw new BadRequestException('当前订单状态不可退款');
        const refundable = order.amountInCents - order.refundAmountInCents;
        if (amountInCents > refundable) throw new BadRequestException('退款金额超过可退金额');
        const refundNo = this.generateNo('RF');
        const result = await this.wechatPay.createRefund({ orderNo: order.orderNo, refundNo, refundAmount: amountInCents, totalAmount: order.amountInCents, reason });
        return this.prisma.paymentRefund.create({
            data: { orderId, refundNo, amountInCents, reason, wechatRefundId: result.refund_id, status: this.mapRefundStatus(result.status) },
        });
    }

    async handleRefundNotification(headers: Record<string, string | string[] | undefined>, rawBody: string) {
        this.wechatPay.verifyNotification(this.header(headers, 'wechatpay-timestamp'), this.header(headers, 'wechatpay-nonce'), this.header(headers, 'wechatpay-signature'), rawBody);
        const envelope = JSON.parse(rawBody) as { resource: any };
        const data = this.wechatPay.decryptNotification<any>(envelope.resource);
        await this.applyRefundResult(data);
        return { code: 'SUCCESS', message: '成功' };
    }

    async applyRefundResult(data: any) {
        const refund = await this.prisma.paymentRefund.findUnique({ where: { refundNo: data.out_refund_no }, include: { order: true } });
        if (!refund || data.refund_status !== 'SUCCESS' || refund.status === PaymentRefundStatus.SUCCESS) return;
        await this.prisma.$transaction(async (tx) => {
            await tx.paymentRefund.update({ where: { id: refund.id }, data: { status: PaymentRefundStatus.SUCCESS, successAt: data.success_time ? new Date(data.success_time) : new Date(), wechatRefundId: data.refund_id } });
            const refunded = refund.order.refundAmountInCents + refund.amountInCents;
            const full = refunded >= refund.order.amountInCents;
            await tx.paymentOrder.update({ where: { id: refund.orderId }, data: { refundAmountInCents: refunded, status: full ? PaymentOrderStatus.REFUNDED : PaymentOrderStatus.PARTIALLY_REFUNDED, refundedAt: full ? new Date() : null } });
            if (full && refund.order.subscriptionId) await tx.tenantSubscription.update({ where: { id: refund.order.subscriptionId }, data: { status: SubscriptionStatus.CANCELED, notes: '关联订单已全额退款' } });
        });
    }

    async reconcilePendingOrders() {
        const orders = await this.prisma.paymentOrder.findMany({ where: { status: { in: [PaymentOrderStatus.PENDING, PaymentOrderStatus.FAILED] } }, orderBy: { createdAt: 'asc' }, take: 100 });
        let synced = 0;
        for (const order of orders) {
            try {
                const transaction = (await this.wechatPay.queryOrder(order.orderNo)) as WechatTransaction;
                await this.applyWechatTransaction(transaction);
                synced += 1;
            } catch {
                // 单笔异常不阻断批量对账，管理员可再次发起。
            }
        }
        return { checked: orders.length, synced };
    }

    private mapRefundStatus(status: string): PaymentRefundStatus {
        if (status === 'SUCCESS') return PaymentRefundStatus.SUCCESS;
        if (status === 'CLOSED') return PaymentRefundStatus.CLOSED;
        if (status === 'ABNORMAL') return PaymentRefundStatus.ABNORMAL;
        return PaymentRefundStatus.PENDING;
    }

    private generateNo(prefix: string) {
        const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
        return `${prefix}${stamp}${randomBytes(5).toString('hex').toUpperCase()}`;
    }

    private header(headers: Record<string, string | string[] | undefined>, name: string): string {
        const value = headers[name];
        if (!value) throw new BadRequestException(`缺少回调请求头 ${name}`);
        return Array.isArray(value) ? value[0] : value;
    }
}
