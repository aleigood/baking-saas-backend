import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockSmsProvider } from './mock-sms.provider';
import { SMS_PROVIDER } from './sms-provider.interface';
import { SmsService } from './sms.service';

@Module({
    providers: [
        SmsService,
        MockSmsProvider,
        {
            provide: SMS_PROVIDER,
            inject: [ConfigService, MockSmsProvider],
            useFactory: (config: ConfigService, mockProvider: MockSmsProvider) => {
                const provider = config.get<string>('SMS_PROVIDER', 'mock').toLowerCase();
                if (provider === 'mock') return mockProvider;
                throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
            },
        },
    ],
    exports: [SmsService],
})
export class SmsModule {}
