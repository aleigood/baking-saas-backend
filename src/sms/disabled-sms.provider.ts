import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SmsProvider } from './sms-provider.interface';

@Injectable()
export class DisabledSmsProvider implements SmsProvider {
    sendRegistrationCode(): Promise<void> {
        throw new ServiceUnavailableException('目前未开放注册，联系管理员进行开通');
    }
}
