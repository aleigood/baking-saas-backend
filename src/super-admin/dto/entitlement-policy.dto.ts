import { Type } from 'class-transformer';
import {
    IsBoolean,
    IsEnum,
    IsInt,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
} from 'class-validator';
import { EntitlementTier } from '@prisma/client';

export class EntitlementLimitsDto {
    @IsInt()
    @Min(1)
    @IsOptional()
    mainRecipes!: number | null;

    @IsInt()
    @Min(1)
    @IsOptional()
    productionTasksPerMonth!: number | null;

    @IsInt()
    @Min(1)
    @IsOptional()
    members!: number | null;
}

export class EntitlementFeaturesDto {
    @IsBoolean()
    costing!: boolean;

    @IsBoolean()
    statistics!: boolean;

    @IsBoolean()
    batchImport!: boolean;

    @IsBoolean()
    export!: boolean;
}

export class UpsertEntitlementPolicyDto {
    @IsEnum(EntitlementTier)
    tier!: EntitlementTier;

    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsObject()
    @ValidateNested()
    @Type(() => EntitlementLimitsDto)
    limits!: EntitlementLimitsDto;

    @IsObject()
    @ValidateNested()
    @Type(() => EntitlementFeaturesDto)
    features!: EntitlementFeaturesDto;
}

export class UpdateBillingSettingsDto {
    @IsInt()
    @Min(1)
    trialDays!: number;

    @IsInt()
    @Min(0)
    graceDays!: number;
}
