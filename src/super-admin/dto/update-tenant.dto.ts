import { IsString, IsOptional } from 'class-validator';

export class UpdateTenantDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    address?: string;
}
