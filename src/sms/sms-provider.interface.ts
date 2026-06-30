export interface SmsProvider {
    sendRegistrationCode(phone: string, code: string): Promise<void>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
