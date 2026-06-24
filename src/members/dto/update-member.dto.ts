import { IsEnum, IsOptional } from 'class-validator';
import { TenantRole, UserStatus } from '@prisma/client';

export class UpdateMemberDto {
    @IsEnum(TenantRole)
    @IsOptional()
    role?: TenantRole;

    @IsEnum(UserStatus)
    @IsOptional()
    status?: UserStatus;
}
