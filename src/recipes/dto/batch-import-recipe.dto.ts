import { Type } from 'class-transformer';
import {
    IsArray,
    ValidateNested,
    IsString,
    IsNotEmpty,
    IsOptional,
    IsNumber,
    IsEnum,
    IsBoolean,
} from 'class-validator';
import { RecipeCategory, RecipeType } from '@prisma/client';

class BatchProductIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsOptional()
    ratio?: number;

    @IsNumber()
    @IsOptional()
    weightInGrams?: number;
}

class BatchProductDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    weight: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchProductIngredientDto)
    @IsOptional()
    fillings?: BatchProductIngredientDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchProductIngredientDto)
    @IsOptional()
    mixIn?: BatchProductIngredientDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchProductIngredientDto)
    @IsOptional()
    toppings?: BatchProductIngredientDto[];

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    procedure?: string[];
}

class BatchComponentIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsOptional()
    ratio?: number;

    @IsNumber()
    @IsOptional()
    flourRatio?: number;

    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    @IsNumber()
    @IsOptional()
    waterContent?: number;
}

export class BatchImportRecipeDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(RecipeType)
    @IsNotEmpty()
    type: RecipeType;

    @IsEnum(RecipeCategory)
    @IsNotEmpty()
    category: RecipeCategory;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsNumber()
    @IsOptional()
    targetTemp?: number;

    @IsNumber()
    @IsOptional()
    lossRatio?: number;

    // [核心新增] 新增分割定额损耗字段
    @IsNumber()
    @IsOptional()
    divisionLoss?: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchComponentIngredientDto)
    ingredients: BatchComponentIngredientDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchProductDto)
    @IsOptional()
    products?: BatchProductDto[];

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    procedure?: string[];
}

export class BatchImportResultDto {
    totalCount: number;
    importedCount: number;
    skippedCount: number;
    skippedRecipes: string[];
}
