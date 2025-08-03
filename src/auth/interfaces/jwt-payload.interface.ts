import { Role } from '@prisma/client';

export interface JwtPayload {
  sub: string; // subject (user id)
  tenantId: string;
  role: Role; // role within the tenant
  globalRole?: Role; // user's global role (e.g. SUPER_ADMIN)
}
