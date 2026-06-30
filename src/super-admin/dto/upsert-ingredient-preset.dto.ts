import { IsBoolean, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpsertIngredientPresetDto {
    @IsString()
    @IsNotEmpty()
    name!: string;

    @IsBoolean()
    isFlour!: boolean;

    @IsNumber()
    @Min(0)
    @Max(1)
    waterContent!: number;

    @IsBoolean()
    @IsOptional()
    isActive?: boolean;

    @IsInt()
    @Min(0)
    @IsOptional()
    sortOrder?: number;
}
