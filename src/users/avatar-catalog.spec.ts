import { AVATAR_COUNT, getAvatarIdFromPath, getAvatarPath, listAvatarOptions } from './avatar-catalog';

describe('avatar catalog', () => {
    it('exposes the complete ordered avatar catalog', () => {
        const avatars = listAvatarOptions();
        expect(avatars).toHaveLength(AVATAR_COUNT);
        expect(avatars[0]).toEqual({ id: 'avatar-01', url: '/avatars/avatar-01.png' });
        expect(avatars[63]).toEqual({ id: 'avatar-64', url: '/avatars/avatar-64.png' });
    });

    it('accepts only catalog avatar ids', () => {
        expect(getAvatarPath('avatar-09')).toBe('/avatars/avatar-09.png');
        expect(() => getAvatarPath('avatar-65')).toThrow('Invalid avatar id');
        expect(getAvatarIdFromPath('/avatars/avatar-32.png')).toBe('avatar-32');
        expect(getAvatarIdFromPath('https://example.com/custom.png')).toBeNull();
    });
});
