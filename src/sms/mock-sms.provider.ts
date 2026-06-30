import { Injectable, Logger } from '@nestjs/common';
import { SmsProvider } from './sms-provider.interface';

@Injectable()
export class MockSmsProvider implements SmsProvider {
    private readonly logger = new Logger(MockSmsProvider.name);

    async sendRegistrationCode(phone: string): Promise<void> {
        this.logger.log(`Mock registration SMS accepted for ${phone.slice(0, 3)}****${phone.slice(-4)}`);
    }
}
