import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sms } from 'tencentcloud-sdk-nodejs-sms';
import { SmsProvider } from './sms-provider.interface';

type TemplateParameter = 'code' | 'minutes' | 'seconds';

@Injectable()
export class TencentCloudSmsProvider implements SmsProvider {
    private readonly logger = new Logger(TencentCloudSmsProvider.name);

    constructor(private readonly config: ConfigService) {}

    async sendRegistrationCode(phone: string, code: string): Promise<void> {
        const secretId = this.required('TENCENT_CLOUD_SECRET_ID');
        const secretKey = this.required('TENCENT_CLOUD_SECRET_KEY');
        const region = this.required('TENCENT_SMS_REGION');
        const smsSdkAppId = this.required('TENCENT_SMS_SDK_APP_ID');
        const signName = this.required('TENCENT_SMS_SIGN_NAME');
        const templateId = this.required('TENCENT_SMS_TEMPLATE_ID');
        const endpoint = this.config.get<string>('TENCENT_SMS_ENDPOINT', 'sms.tencentcloudapi.com').trim();

        const client = new sms.v20210111.Client({
            credential: { secretId, secretKey },
            region,
            profile: { httpProfile: { endpoint } },
        });

        try {
            const response = await client.SendSms({
                PhoneNumberSet: [`+86${phone}`],
                SmsSdkAppId: smsSdkAppId,
                SignName: signName,
                TemplateId: templateId,
                TemplateParamSet: this.buildTemplateParams(code),
            });
            const status = response.SendStatusSet?.[0];
            if (!status || status.Code !== 'Ok') {
                this.logger.error(
                    `腾讯云短信发送失败：${status?.Code || 'EmptyResponse'} ${status?.Message || ''}`.trim(),
                );
                throw new ServiceUnavailableException('验证码发送失败，请稍后重试');
            }
        } catch (error) {
            if (error instanceof ServiceUnavailableException) throw error;
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`腾讯云短信接口调用失败：${message}`);
            throw new ServiceUnavailableException('验证码发送失败，请稍后重试');
        }
    }

    private buildTemplateParams(code: string): string[] {
        const expiresInSeconds = this.readPositiveInt('SMS_CODE_EXPIRES_SECONDS', 300);
        const values: Record<TemplateParameter, string> = {
            code,
            minutes: String(Math.ceil(expiresInSeconds / 60)),
            seconds: String(expiresInSeconds),
        };
        const parameterNames = this.config
            .get<string>('TENCENT_SMS_TEMPLATE_PARAMS', 'code,minutes')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);

        return parameterNames.map((name) => {
            if (!(name in values)) throw new Error(`Unsupported Tencent SMS template parameter: ${name}`);
            return values[name as TemplateParameter];
        });
    }

    private required(name: string): string {
        const value = this.config.get<string>(name)?.trim();
        if (!value) throw new Error(`Missing required configuration: ${name}`);
        return value;
    }

    private readPositiveInt(name: string, fallback: number): number {
        const value = Number(this.config.get<string>(name));
        return Number.isInteger(value) && value > 0 ? value : fallback;
    }
}
