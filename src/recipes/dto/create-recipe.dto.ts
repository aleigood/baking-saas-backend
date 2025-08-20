import {
    IsString,
    IsNotEmpty,
    IsArray,
    ValidateNested,
    IsOptional,
    IsNumber,
    IsEnum,
    IsBoolean,
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
// [核心修正] 增加 export 关键字，使其可以在模块外被导入
export class DoughIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    ratio: number;

    // [核心修正] 增加 isFlour 和 waterContent 字段以接收导入数据
    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    @IsNumber()
    @IsOptional()
    waterContent?: number;
}

// 主创建DTO
export class CreateRecipeDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(RecipeType)
    @IsOptional()
    type?: RecipeType; // 'MAIN', 'PRE_DOUGH', 'EXTRA'

    @IsString()
    @IsOptional()
    notes?: string;

    @IsNumber()
    @IsOptional()
    targetTemp?: number;

    @IsNumber()
    @IsOptional()
    lossRatio?: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => DoughIngredientDto)
    ingredients: DoughIngredientDto[];

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
