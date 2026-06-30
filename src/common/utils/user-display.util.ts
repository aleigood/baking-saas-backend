export function maskPhone(phone: string): string {
    if (!/^1\d{10}$/.test(phone)) return phone;
    return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function getUserDisplayName(user: { name: string | null; phone: string }): string {
    const name = user.name?.trim();
    return name || maskPhone(user.phone);
}
