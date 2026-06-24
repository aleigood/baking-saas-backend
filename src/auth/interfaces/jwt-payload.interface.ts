import { GlobalRole, TenantRole } from '@prisma/client';

export interface JwtPayload {
    sub: string; // subject (user id)
    tenantId: string;
    tenantRole: TenantRole;
    globalRole: GlobalRole;
}
