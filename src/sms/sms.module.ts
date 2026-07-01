import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockSmsProvider } from './mock-sms.provider';
import { SMS_PROVIDER } from './sms-provider.interface';
import { SmsService } from './sms.service';
import { DisabledSmsProvider } from './disabled-sms.provider';

@Module({
    providers: [
        SmsService,
        MockSmsProvider,
        DisabledSmsProvider,
        {
            provide: SMS_PROVIDER,
            inject: [ConfigService, MockSmsProvider, DisabledSmsProvider],
            useFactory: (config: ConfigService, mockProvider: MockSmsProvider, disabledProvider: DisabledSmsProvider) => {
                const fallback = config.get<string>('NODE_ENV') === 'production' ? 'disabled' : 'mock';
                const provider = config.get<string>('SMS_PROVIDER', fallback).toLowerCase();
                if (provider === 'mock') return mockProvider;
                if (provider === 'disabled') return disabledProvider;
                throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
            },
        },
    ],
    exports: [SmsService],
})
export class SmsModule {}
