import { Body, Controller, Get, Headers, HttpCode, Param, Post, RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { GetUser } from '../auth/decorators/get-user.decorator';
import { UserPayload } from '../auth/interfaces/user-payload.interface';
import { BillingService } from './billing.service';
import { CreatePaymentOrderDto } from './dto/billing.dto';
import { EntitlementsService } from './entitlements.service';

@Controller('billing')
export class BillingController {
    constructor(
        private readonly billingService: BillingService,
        private readonly entitlementsService: EntitlementsService,
    ) {}

    @Get('plans')
    listPlans() {
        return this.billingService.listPlans();
    }

    @Get('capabilities')
    getPaymentCapabilities() {
        return this.billingService.getPaymentCapabilities();
    }

    @Get('catalog')
    getCatalog() {
        return this.entitlementsService.getCatalog();
    }

    @UseGuards(AuthGuard('jwt'))
    @Get('subscription')
    getSubscription(@GetUser() user: UserPayload) {
        return this.billingService.getSubscription(user.tenantId);
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('trial/start')
    startTrial(@GetUser() user: UserPayload) {
        return this.entitlementsService.startTrial(user.tenantId, user.sub, user.tenantRole);
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('free-tier/recipes/:recipeId/unrestrict')
    unrestrictFreeRecipe(@GetUser() user: UserPayload, @Param('recipeId') recipeId: string) {
        return this.entitlementsService.unrestrictFreeRecipe(user.tenantId, user.tenantRole, recipeId);
    }

    @UseGuards(AuthGuard('jwt'))
    @Post('orders')
    createOrder(@GetUser() user: UserPayload, @Body() dto: CreatePaymentOrderDto) {
        return this.billingService.createOrder(user.sub, user.tenantId, user.tenantRole, dto.planId);
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
    paymentNotify(
        @Req() request: RawBodyRequest<Request>,
        @Headers() headers: Record<string, string | string[] | undefined>,
    ) {
        return this.billingService.handlePaymentNotification(headers, request.rawBody?.toString('utf8') || '');
    }

    @Post('wechat/refund-notify')
    @HttpCode(200)
    refundNotify(
        @Req() request: RawBodyRequest<Request>,
        @Headers() headers: Record<string, string | string[] | undefined>,
    ) {
        return this.billingService.handleRefundNotification(headers, request.rawBody?.toString('utf8') || '');
    }
}
