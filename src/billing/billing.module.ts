import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { WechatPayService } from './wechat-pay.service';
import { EntitlementsService } from './entitlements.service';
import { FeatureGuard } from './feature.guard';

@Global()
@Module({
    controllers: [BillingController],
    providers: [BillingService, WechatPayService, EntitlementsService, FeatureGuard],
    exports: [BillingService, EntitlementsService, FeatureGuard],
})
export class BillingModule {}
