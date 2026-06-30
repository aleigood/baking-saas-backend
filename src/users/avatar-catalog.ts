import { randomInt } from 'crypto';

export const AVATAR_COUNT = 64;

export interface AvatarOption {
    id: string;
    url: string;
}

export function getAvatarId(index: number): string {
    return `avatar-${index.toString().padStart(2, '0')}`;
}

export function getAvatarPath(avatarId: string): string {
    if (!isAvatarId(avatarId)) throw new Error(`Invalid avatar id: ${avatarId}`);
    return `/avatars/${avatarId}.png`;
}

export function getAvatarIdFromPath(path?: string | null): string | null {
    if (!path) return null;
    const match = path.match(/\/avatars\/(avatar-\d{2})\.png$/);
    return match && isAvatarId(match[1]) ? match[1] : null;
}

export function getRandomAvatarPath(): string {
    return getAvatarPath(getAvatarId(randomInt(1, AVATAR_COUNT + 1)));
}

export function listAvatarOptions(): AvatarOption[] {
    return Array.from({ length: AVATAR_COUNT }, (_, index) => {
        const id = getAvatarId(index + 1);
        return { id, url: getAvatarPath(id) };
    });
}

function isAvatarId(avatarId: string): boolean {
    const match = avatarId.match(/^avatar-(\d{2})$/);
    if (!match) return false;
    const index = Number(match[1]);
    return index >= 1 && index <= AVATAR_COUNT;
}
