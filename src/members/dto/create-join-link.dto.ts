import { IsEnum } from 'class-validator';
import { TenantRole } from '@prisma/client';

export class CreateJoinLinkDto {
    @IsEnum(TenantRole)
    role: TenantRole;
}
