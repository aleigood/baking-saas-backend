import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { sms } from 'tencentcloud-sdk-nodejs-sms';
import { TencentCloudSmsProvider } from './tencent-cloud-sms.provider';

describe('TencentCloudSmsProvider', () => {
    const configValues: Record<string, string> = {
        TENCENT_CLOUD_SECRET_ID: 'secret-id',
        TENCENT_CLOUD_SECRET_KEY: 'secret-key',
        TENCENT_SMS_REGION: 'ap-guangzhou',
        TENCENT_SMS_SDK_APP_ID: '1400000000',
        TENCENT_SMS_SIGN_NAME: '测试签名',
        TENCENT_SMS_TEMPLATE_ID: '123456',
        TENCENT_SMS_TEMPLATE_PARAMS: 'code,minutes',
        SMS_CODE_EXPIRES_SECONDS: '300',
    };

    function createProvider(overrides: Record<string, string> = {}) {
        const values = { ...configValues, ...overrides };
        const config = { get: jest.fn((name: string, fallback?: string) => values[name] ?? fallback) };
        return new TencentCloudSmsProvider(config as unknown as ConfigService);
    }

    afterEach(() => jest.restoreAllMocks());

    it('sends the verification code with the configured Tencent Cloud template', async () => {
        const sendSms = jest.fn().mockResolvedValue({ SendStatusSet: [{ Code: 'Ok', Message: 'send success' }] });
        jest.spyOn(sms.v20210111, 'Client').mockImplementation(() => ({ SendSms: sendSms }) as never);

        await createProvider().sendRegistrationCode('13800138000', '654321');

        expect(sendSms).toHaveBeenCalledWith({
            PhoneNumberSet: ['+8613800138000'],
            SmsSdkAppId: '1400000000',
            SignName: '测试签名',
            TemplateId: '123456',
            TemplateParamSet: ['654321', '5'],
        });
    });

    it('supports templates containing only the verification code', async () => {
        const sendSms = jest.fn().mockResolvedValue({ SendStatusSet: [{ Code: 'Ok' }] });
        jest.spyOn(sms.v20210111, 'Client').mockImplementation(() => ({ SendSms: sendSms }) as never);

        await createProvider({ TENCENT_SMS_TEMPLATE_PARAMS: 'code' }).sendRegistrationCode('13800138000', '123456');

        expect(sendSms).toHaveBeenCalledWith(expect.objectContaining({ TemplateParamSet: ['123456'] }));
    });

    it('maps Tencent Cloud delivery rejection to a user-facing unavailable error', async () => {
        jest.spyOn(sms.v20210111, 'Client').mockImplementation(
            () =>
                ({
                    SendSms: jest.fn().mockResolvedValue({
                        SendStatusSet: [
                            { Code: 'FailedOperation.TemplateIncorrectOrUnapproved', Message: 'unapproved' },
                        ],
                    }),
                }) as never,
        );

        await expect(createProvider().sendRegistrationCode('13800138000', '123456')).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });
});
