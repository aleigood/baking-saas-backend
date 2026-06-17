import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

export class UpsertSubscriptionPlanDto {
    @IsString()
    @IsNotEmpty()
    code!: string;

    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsInt()
    @Min(1)
    durationDays!: number;

    @IsInt()
    @Min(0)
    priceInCents!: number;

    @IsOptional()
    @IsInt()
    @Min(0)
    originalPriceInCents?: number | null;

    @IsOptional()
    @IsBoolean()
    isActive?: boolean;

    @IsOptional()
    @IsInt()
    sortOrder?: number;
}
