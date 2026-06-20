import { Body, Controller, Get, Headers, HttpCode, Param, Post, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { BillingService } from './billing.service';
import { CreatePaymentOrderDto } from './dto/billing.dto';

@Controller('billing')
export class BillingController {
    constructor(private readonly billingService: BillingService) {}

    @Get('plans')
    listPlans() {
        return this.billingService.listPlans();
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('subscription')
    getSubscription(@GetUser() user: UserPayload) {
        return this.billingService.getSubscription(user.tenantId);
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('orders')
    createOrder(@GetUser() user: UserPayload, @Body() dto: CreatePaymentOrderDto) {
        return this.billingService.createOrder(user.sub, user.tenantId, user.role, dto.planId);
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('orders/:orderNo')
    getOrder(@GetUser() user: UserPayload, @Param('orderNo') orderNo: string) {
        return this.billingService.getOrder(user.tenantId, orderNo);
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('orders/:orderNo/sync')
    syncOrder(@GetUser() user: UserPayload, @Param('orderNo') orderNo: string) {
        return this.billingService.syncOrder(user.tenantId, orderNo);
    }

    @Post('wechat/notify')
    @HttpCode(200)
    paymentNotify(@Req() request: RawBodyRequest<Request>, @Headers() headers: Record<string, string | string[] | undefined>) {
        return this.billingService.handlePaymentNotification(headers, request.rawBody?.toString('utf8') || '');
    }

    @Post('wechat/refund-notify')
    @HttpCode(200)
    refundNotify(@Req() request: RawBodyRequest<Request>, @Headers() headers: Record<string, string | string[] | undefined>) {
        return this.billingService.handleRefundNotification(headers, request.rawBody?.toString('utf8') || '');
    }
}
