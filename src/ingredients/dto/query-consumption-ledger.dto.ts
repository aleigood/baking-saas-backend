import { IsDateString, IsNumberString, IsOptional, IsString } from 'class-validator';

export class QueryConsumptionLedgerDto {
    @IsNumberString()
    @IsOptional()
    page?: string;

    @IsNumberString()
    @IsOptional()
    limit?: string;

    @IsDateString()
    @IsOptional()
    startDate?: string;

    @IsDateString()
    @IsOptional()
    endDate?: string;

    @IsString()
    @IsOptional()
    keyword?: string;

    @IsString()
    @IsOptional()
    userId?: string;
}
