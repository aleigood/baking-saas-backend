import { GlobalRole, TenantRole } from '@prisma/client';

export interface UserPayload {
    sub: string;
    tenantId: string;
    tenantRole: TenantRole;
    globalRole: GlobalRole;
    iat: number;
    exp: number;
}
