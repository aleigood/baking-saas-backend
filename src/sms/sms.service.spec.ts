import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SmsProvider } from './sms-provider.interface';
import { SmsService } from './sms.service';

describe('SmsService', () => {
    const challenge = {
        id: 'challenge-1',
        phone: '13800138000',
        codeHash: '',
        expiresAt: new Date(Date.now() + 300_000),
        consumedAt: null,
        attemptCount: 0,
        requestIp: '127.0.0.1',
        createdAt: new Date(),
        updatedAt: new Date(),
        purpose: 'REGISTER' as const,
    };

    function createService(overrides: Record<string, string> = {}) {
        const tx = {
            smsVerificationCode: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                create: jest.fn().mockResolvedValue(challenge),
            },
        };
        const prisma = {
            user: { findUnique: jest.fn().mockResolvedValue(null) },
            smsVerificationCode: {
                findFirst: jest.fn().mockResolvedValue(null),
                count: jest.fn().mockResolvedValue(0),
                update: jest.fn().mockResolvedValue(challenge),
            },
            $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
        } as unknown as PrismaService;
        const values: Record<string, string> = {
            NODE_ENV: 'development',
            SMS_PROVIDER: 'mock',
            SMS_TEST_CODE: '123456',
            ...overrides,
        };
        const config = { get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback) } as unknown as ConfigService;
        const provider = { sendRegistrationCode: jest.fn().mockResolvedValue(undefined) } as SmsProvider;
        return { service: new SmsService(prisma, config, provider), prisma, provider, tx };
    }

    it('returns the configured code only in development mock mode', async () => {
        const { service, provider } = createService();
        service.onModuleInit();

        const result = await service.sendRegistrationCode('13800138000', '127.0.0.1');

        expect(result.debugCode).toBe('123456');
        expect(provider.sendRegistrationCode).toHaveBeenCalledWith('13800138000', '123456');
    });

    it('rejects mock mode in production', () => {
        const { service } = createService({ NODE_ENV: 'production' });
        expect(() => service.onModuleInit()).toThrow('Production must use a real SMS provider');
    });
});
