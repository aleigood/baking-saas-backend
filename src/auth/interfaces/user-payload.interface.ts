import { Role } from '@prisma/client';

export interface UserPayload {
  sub: string;
  tenantId: string;
  role: Role;
  globalRole?: Role;
  iat: number;
  exp: number;
}
