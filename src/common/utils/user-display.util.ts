export function maskPhone(phone?: string | null): string {
    if (!phone) return '';
    if (!/^1\d{10}$/.test(phone)) return phone;
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function getUserDisplayName(user: {
    name: string | null;
    wechatNickname?: string | null;
    phone?: string | null;
}): string {
    const nickname = user.wechatNickname?.trim();
    const name = user.name?.trim();
    return nickname || name || maskPhone(user.phone) || '微信用户';
}
