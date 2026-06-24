import { TenantRole } from '@prisma/client';

export class MemberDto {
    id!: string;
    name!: string;
    role!: TenantRole;
    joinDate!: string;
}
