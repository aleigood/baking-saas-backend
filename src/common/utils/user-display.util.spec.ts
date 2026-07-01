import { getUserDisplayName, maskPhone } from './user-display.util';

describe('user display helpers', () => {
    it('uses a trimmed optional name when available', () => {
        expect(getUserDisplayName({ name: ' 小麦 ', phone: '13800138000' })).toBe('小麦');
    });

    it('prefers the WeChat nickname for client display', () => {
        expect(getUserDisplayName({ name: '张三', wechatNickname: '麦香', phone: '13800138000' })).toBe('麦香');
    });

    it('falls back to a masked phone instead of inventing a username', () => {
        expect(getUserDisplayName({ name: null, phone: '13800138000' })).toBe('138****8000');
        expect(maskPhone('13800138000')).toBe('138****8000');
    });

    it('uses a neutral display name for a WeChat-only account', () => {
        expect(getUserDisplayName({ name: null, phone: null })).toBe('微信用户');
    });
});
