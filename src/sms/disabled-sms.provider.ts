import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SmsProvider } from './sms-provider.interface';

@Injectable()
export class DisabledSmsProvider implements SmsProvider {
    sendRegistrationCode(): Promise<void> {
        throw new ServiceUnavailableException('短信注册暂不可用');
    }
}
