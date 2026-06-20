import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { WechatPayService } from './wechat-pay.service';
import { SubscriptionGuard } from './subscription.guard';

@Global()
@Module({
    controllers: [BillingController],
    providers: [BillingService, WechatPayService, SubscriptionGuard],
    exports: [BillingService, SubscriptionGuard],
})
export class BillingModule {}
