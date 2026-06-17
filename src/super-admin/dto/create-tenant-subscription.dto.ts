import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateTenantSubscriptionDto {
    @IsString()
    @IsNotEmpty()
    tenantId!: string;

    @IsString()
    @IsNotEmpty()
    planId!: string;

    @IsOptional()
    @IsDateString()
    startsAt?: string;

    @IsOptional()
    @IsString()
    source?: string;

    @IsOptional()
    @IsString()
    notes?: string;
}
