// [核心修改] 重构此文件以支持 "配方族" (Family) 嵌套 "版本" (Version)

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

// [核心修改] 导出, 之前是 'BatchProductIngredientDto'
// (你提供的原始 DTO  中没有导出，导致 service 无法使用)
export class BatchProductIngredientDto {
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

// [核心修改] 导出, 之前是 'BatchProductDto'
export class BatchProductDto {
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

// [核心修改] 导出, 之前是 'BatchComponentIngredientDto'
export class BatchComponentIngredientDto {
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

// [核心新增] 创建 BatchImportVersionDto 来持有 "版本" 特定的数据
// (这是从旧的 BatchImportRecipeDto  迁移过来的)
export class BatchImportVersionDto {
    @IsString()
    @IsNotEmpty() // [核心修改] notes 必须有，用于版本去重
    notes: string;

    @IsNumber()
    @IsOptional()
    targetTemp?: number;

    @IsNumber()
    @IsOptional()
    lossRatio?: number;

    // [核心修改] divisionLoss 字段从 Family  移动到 Version
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

// [核心修改] BatchImportRecipeDto  现在是 "配方族" (Family) 级别
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

    // [核心修改] 嵌套 BatchImportVersionDto 数组
    // 这将修复 'Property 'versions' does not exist' 错误 [cite: 2, 32, 34]
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchImportVersionDto)
    versions: BatchImportVersionDto[];
}

export class BatchImportResultDto {
    totalCount: number;
    importedCount: number;
    skippedCount: number;
    skippedRecipes: string[];
}
