import {
    IsString,
    IsNotEmpty,
    IsArray,
    ValidateNested,
    IsOptional,
    IsNumber,
    IsBoolean,
    IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductIngredientType, RecipeType } from '@prisma/client';

// 用于产品中附加原料（搅拌、馅料、装饰）的DTO
class ProductIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(ProductIngredientType)
    @IsNotEmpty()
    type: ProductIngredientType; // 'MIX_IN', 'FILLING', 'TOPPING'

    @IsNumber()
    @IsOptional()
    ratio?: number; // 搅拌类原料的百分比

    @IsNumber()
    @IsOptional()
    weightInGrams?: number; // 馅料/装饰类原料的克重
}

// 用于最终产品的DTO
class ProductDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    weight: number; // 基础面团克重

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductIngredientDto)
    @IsOptional()
    fillings?: ProductIngredientDto[]; // 馅料

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductIngredientDto)
    @IsOptional()
    mixIn?: ProductIngredientDto[]; // 搅拌加入的原料

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductIngredientDto)
    @IsOptional()
    toppings?: ProductIngredientDto[]; // 表面装饰

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    procedure?: string[]; // 制作流程
}

// 用于面团中原料的DTO
class DoughIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    ratio: number;

    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    @IsNumber()
    @IsOptional()
    waterContent?: number;
}

// [新增] 用于面团的DTO，它可以包含多个原料
class DoughDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsOptional()
    targetTemp?: number;

    @IsNumber()
    @IsOptional()
    lossRatio?: number;

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    procedure?: string[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => DoughIngredientDto)
    ingredients: DoughIngredientDto[];
}

// 主创建DTO
export class CreateRecipeDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(RecipeType)
    @IsOptional()
    type?: RecipeType; // 'MAIN', 'PRE_DOUGH', 'EXTRA'

    // [新增] 版本说明字段
    @IsString()
    @IsOptional()
    notes?: string;

    @IsNumber()
    @IsOptional()
    targetTemp?: number;

    @IsNumber()
    @IsOptional()
    lossRatio?: number;

    // [修改] 从 ingredients: DoughIngredientDto[] 改为 doughs: DoughDto[]
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => DoughDto)
    doughs: DoughDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductDto)
    @IsOptional()
    products?: ProductDto[];

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    procedure?: string[];
}
