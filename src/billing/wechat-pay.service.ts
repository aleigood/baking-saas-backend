import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createDecipheriv, createSign, createVerify, randomBytes } from 'crypto';

interface WechatNotificationResource {
    algorithm: string;
    ciphertext: string;
    associated_data?: string;
    nonce: string;
}

@Injectable()
export class WechatPayService {
    private readonly baseUrl = 'https://api.mch.weixin.qq.com';

    private required(name: string): string {
        const value = process.env[name];
        if (!value) throw new ServiceUnavailableException(`微信支付尚未配置：${name}`);
        return value;
    }

    private decodeKey(name: string): string {
        const encoded = this.required(name);
        return Buffer.from(encoded, 'base64').toString('utf8');
    }

    private sign(message: string): string {
        const signer = createSign('RSA-SHA256');
        signer.update(message);
        signer.end();
        return signer.sign(this.decodeKey('WECHAT_PAY_PRIVATE_KEY_BASE64'), 'base64');
    }

    private authorization(method: string, path: string, body = ''): string {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = randomBytes(16).toString('hex');
        const signature = this.sign(`${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
        return `WECHATPAY2-SHA256-RSA2048 mchid="${this.required('WECHAT_PAY_MCH_ID')}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.required('WECHAT_PAY_SERIAL_NO')}"`;
    }

    private async request<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
        const body = payload ? JSON.stringify(payload) : '';
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: this.authorization(method, path, body),
                'User-Agent': 'baking-saas/1.0',
            },
            body: body || undefined,
        });
        const text = await response.text();
        const data: T & { message?: string } = text ? (JSON.parse(text) as T & { message?: string }) : ({} as T & { message?: string });
        if (!response.ok) {
            throw new BadGatewayException(data.message || `微信支付接口调用失败 (${response.status})`);
        }
        return data;
    }

    async createJsapiOrder(input: { orderNo: string; amountInCents: number; description: string; openId: string }) {
        const result = await this.request<{ prepay_id: string }>('POST', '/v3/pay/transactions/jsapi', {
            appid: this.required('WECHAT_APP_ID'),
            mchid: this.required('WECHAT_PAY_MCH_ID'),
            description: input.description,
            out_trade_no: input.orderNo,
            notify_url: this.required('WECHAT_PAY_NOTIFY_URL'),
            amount: { total: input.amountInCents, currency: 'CNY' },
            payer: { openid: input.openId },
        });

        const timeStamp = Math.floor(Date.now() / 1000).toString();
        const nonceStr = randomBytes(16).toString('hex');
        const packageValue = `prepay_id=${result.prepay_id}`;
        return {
            prepayId: result.prepay_id,
            paymentParams: {
                timeStamp,
                nonceStr,
                package: packageValue,
                signType: 'RSA' as const,
                paySign: this.sign(`${this.required('WECHAT_APP_ID')}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`),
            },
        };
    }

    queryOrder(orderNo: string) {
        const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(this.required('WECHAT_PAY_MCH_ID'))}`;
        return this.request<any>('GET', path);
    }

    createRefund(input: { orderNo: string; refundNo: string; refundAmount: number; totalAmount: number; reason?: string }) {
        return this.request<any>('POST', '/v3/refund/domestic/refunds', {
            out_trade_no: input.orderNo,
            out_refund_no: input.refundNo,
            reason: input.reason,
            notify_url: this.required('WECHAT_PAY_REFUND_NOTIFY_URL'),
            amount: { refund: input.refundAmount, total: input.totalAmount, currency: 'CNY' },
        });
    }

    verifyNotification(timestamp: string, nonce: string, signature: string, rawBody: string): void {
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
        verifier.end();
        const valid = verifier.verify(this.decodeKey('WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64'), signature, 'base64');
        if (!valid) throw new BadGatewayException('微信支付回调签名验证失败');
    }

    decryptNotification<T>(resource: WechatNotificationResource): T {
        if (resource.algorithm !== 'AEAD_AES_256_GCM') throw new BadGatewayException('不支持的微信支付回调算法');
        const encrypted = Buffer.from(resource.ciphertext, 'base64');
        const authTag = encrypted.subarray(encrypted.length - 16);
        const ciphertext = encrypted.subarray(0, encrypted.length - 16);
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(this.required('WECHAT_PAY_API_V3_KEY')), Buffer.from(resource.nonce));
        decipher.setAuthTag(authTag);
        decipher.setAAD(Buffer.from(resource.associated_data || ''));
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as T;
    }
}
