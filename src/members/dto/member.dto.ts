import { Role } from '@prisma/client';

export class MemberDto {
    id: string;
    name: string;
    role: Role;
    joinDate: string;
}
