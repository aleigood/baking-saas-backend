import { getUserDisplayName, maskPhone } from './user-display.util';

describe('user display helpers', () => {
    it('uses a trimmed optional name when available', () => {
        expect(getUserDisplayName({ name: ' 小麦 ', phone: '13800138000' })).toBe('小麦');
    });

    it('falls back to a masked phone instead of inventing a username', () => {
        expect(getUserDisplayName({ name: null, phone: '13800138000' })).toBe('138****8000');
        expect(maskPhone('13800138000')).toBe('138****8000');
    });
});
