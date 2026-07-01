import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SmsPurpose } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SMS_PROVIDER, SmsProvider } from './sms-provider.interface';

export interface SmsCodeResponse {
    message: string;
    expiresInSeconds: number;
    retryAfterSeconds: number;
    debugCode?: string;
}

@Injectable()
export class SmsService implements OnModuleInit {
    private readonly providerName: string;
    private readonly testCode?: string;
    private readonly expiresInSeconds: number;
    private readonly cooldownSeconds: number;
    private readonly maxAttempts: number;

    constructor(
        private readonly prisma: PrismaService,
        private readonly config: ConfigService,
        @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    ) {
        const fallbackProvider = this.config.get<string>('NODE_ENV') === 'production' ? 'disabled' : 'mock';
        this.providerName = this.config.get<string>('SMS_PROVIDER', fallbackProvider).toLowerCase();
        this.testCode = this.config.get<string>('SMS_TEST_CODE')?.trim();
        this.expiresInSeconds = this.readPositiveInt('SMS_CODE_EXPIRES_SECONDS', 300);
        this.cooldownSeconds = this.readPositiveInt('SMS_CODE_COOLDOWN_SECONDS', 60);
        this.maxAttempts = this.readPositiveInt('SMS_CODE_MAX_ATTEMPTS', 5);
    }

    onModuleInit(): void {
        const isProduction = this.config.get<string>('NODE_ENV') === 'production';
        if (isProduction && (this.providerName === 'mock' || this.testCode)) {
            throw new Error('Production must use a real SMS provider and cannot configure SMS_TEST_CODE');
        }
        if (this.testCode && !/^\d{6}$/.test(this.testCode)) {
            throw new Error('SMS_TEST_CODE must contain exactly 6 digits');
        }
        if (this.providerName === 'tencent') {
            const requiredNames = [
                'TENCENT_CLOUD_SECRET_ID',
                'TENCENT_CLOUD_SECRET_KEY',
                'TENCENT_SMS_REGION',
                'TENCENT_SMS_SDK_APP_ID',
                'TENCENT_SMS_SIGN_NAME',
                'TENCENT_SMS_TEMPLATE_ID',
            ];
            const missingNames = requiredNames.filter((name) => !this.config.get<string>(name)?.trim());
            if (missingNames.length > 0) {
                throw new Error(`Tencent SMS configuration is incomplete: ${missingNames.join(', ')}`);
            }
        }
    }

    async sendRegistrationCode(phone: string, requestIp?: string): Promise<SmsCodeResponse> {
        const existingUser = await this.prisma.user.findUnique({ where: { phone }, select: { id: true } });
        if (existingUser) throw new ConflictException('该手机号已注册，请直接登录');

        return this.sendCode(phone, requestIp);
    }

    sendProfileCode(phone: string, requestIp?: string): Promise<SmsCodeResponse> {
        return this.sendCode(phone, requestIp);
    }

    async issueAssistedCode(phone: string, requestIp?: string): Promise<{ code: string; expiresInSeconds: number }> {
        const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
        await this.createChallenge(phone, code, requestIp);
        return { code, expiresInSeconds: this.expiresInSeconds };
    }

    private async sendCode(phone: string, requestIp?: string): Promise<SmsCodeResponse> {
        await this.assertRateLimits(phone, requestIp);

        const code = this.testCode || randomInt(0, 1_000_000).toString().padStart(6, '0');
        const challenge = await this.createChallenge(phone, code, requestIp);

        try {
            await this.provider.sendRegistrationCode(phone, code);
        } catch (error) {
            await this.prisma.smsVerificationCode.update({
                where: { id: challenge.id },
                data: { consumedAt: new Date() },
            });
            throw error;
        }

        const response: SmsCodeResponse = {
            message: '验证码已发送',
            expiresInSeconds: this.expiresInSeconds,
            retryAfterSeconds: this.cooldownSeconds,
        };
        if (this.providerName === 'mock' && this.config.get<string>('NODE_ENV') !== 'production') {
            response.debugCode = code;
        }
        return response;
    }

    private async createChallenge(phone: string, code: string, requestIp?: string) {
        const codeHash = await bcrypt.hash(code, 10);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.expiresInSeconds * 1000);
        return this.prisma.$transaction(async (tx) => {
            await tx.smsVerificationCode.updateMany({
                where: { phone, purpose: SmsPurpose.REGISTER, consumedAt: null },
                data: { consumedAt: now },
            });
            return tx.smsVerificationCode.create({
                data: { phone, purpose: SmsPurpose.REGISTER, codeHash, expiresAt, requestIp },
            });
        });
    }

    async verifyRegistrationCode(phone: string, code: string): Promise<string> {
        const challenge = await this.prisma.smsVerificationCode.findFirst({
            where: { phone, purpose: SmsPurpose.REGISTER, consumedAt: null },
            orderBy: { createdAt: 'desc' },
        });

        if (!challenge || challenge.expiresAt.getTime() <= Date.now()) {
            throw new BadRequestException('验证码已过期，请重新获取');
        }
        if (challenge.attemptCount >= this.maxAttempts) {
            throw new HttpException('验证码尝试次数过多，请重新获取', HttpStatus.TOO_MANY_REQUESTS);
        }

        const matches = await bcrypt.compare(code, challenge.codeHash);
        if (!matches) {
            await this.prisma.smsVerificationCode.update({
                where: { id: challenge.id },
                data: { attemptCount: { increment: 1 } },
            });
            throw new BadRequestException('验证码不正确');
        }
        return challenge.id;
    }

    async consumeRegistrationCode(tx: Prisma.TransactionClient, challengeId: string): Promise<void> {
        const result = await tx.smsVerificationCode.updateMany({
            where: {
                id: challengeId,
                purpose: SmsPurpose.REGISTER,
                consumedAt: null,
                expiresAt: { gt: new Date() },
            },
            data: { consumedAt: new Date() },
        });
        if (result.count !== 1) throw new BadRequestException('验证码已失效，请重新获取');
    }

    private async assertRateLimits(phone: string, requestIp?: string): Promise<void> {
        const now = Date.now();
        const latest = await this.prisma.smsVerificationCode.findFirst({
            where: { phone, purpose: SmsPurpose.REGISTER },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        });
        if (latest) {
            const retryAfter = this.cooldownSeconds - Math.floor((now - latest.createdAt.getTime()) / 1000);
            if (retryAfter > 0)
                throw new HttpException(`请${retryAfter}秒后再获取验证码`, HttpStatus.TOO_MANY_REQUESTS);
        }

        const hourAgo = new Date(now - 60 * 60 * 1000);
        const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
        const [phoneHour, phoneDay, ipHour, ipDay] = await Promise.all([
            this.prisma.smsVerificationCode.count({ where: { phone, createdAt: { gte: hourAgo } } }),
            this.prisma.smsVerificationCode.count({ where: { phone, createdAt: { gte: dayAgo } } }),
            requestIp
                ? this.prisma.smsVerificationCode.count({ where: { requestIp, createdAt: { gte: hourAgo } } })
                : Promise.resolve(0),
            requestIp
                ? this.prisma.smsVerificationCode.count({ where: { requestIp, createdAt: { gte: dayAgo } } })
                : Promise.resolve(0),
        ]);

        if (
            phoneHour >= this.readPositiveInt('SMS_PHONE_HOURLY_LIMIT', 5) ||
            phoneDay >= this.readPositiveInt('SMS_PHONE_DAILY_LIMIT', 10) ||
            ipHour >= this.readPositiveInt('SMS_IP_HOURLY_LIMIT', 20) ||
            ipDay >= this.readPositiveInt('SMS_IP_DAILY_LIMIT', 100)
        ) {
            throw new HttpException('验证码请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
        }
    }

    private readPositiveInt(key: string, fallback: number): number {
        const value = Number(this.config.get<string>(key));
        return Number.isInteger(value) && value > 0 ? value : fallback;
    }
}
