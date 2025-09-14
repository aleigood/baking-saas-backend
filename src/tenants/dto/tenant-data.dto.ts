import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { TenantStatus } from '@prisma/client';

export class TenantDataDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(TenantStatus)
    @IsOptional()
    status?: TenantStatus;
}
