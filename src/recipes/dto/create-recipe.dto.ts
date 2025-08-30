import {
    IsString,
    IsNotEmpty,
    IsArray,
    ValidateNested,
    IsOptional,
    IsNumber,
    IsEnum,
    IsBoolean,
    IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductIngredientType, RecipeType } from '@prisma/client';

// 用于产品中附加原料（搅拌、馅料、装饰）的DTO
class ProductIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string; // name 字段用于创建新原料或关联预制/附加配方

    @IsEnum(ProductIngredientType)
    @IsNotEmpty()
    type: ProductIngredientType; // 'MIX_IN', 'FILLING', 'TOPPING'

    // [核心修改] ratio 现在应为小数形式 (例如: 1% 应传入 0.01)
    @IsNumber()
    @IsOptional()
    ratio?: number; // 搅拌类原料的百分比

    @IsNumber()
    @IsOptional()
    weightInGrams?: number; // 馅料/装饰类原料的克重

    @IsUUID()
    @IsOptional()
    ingredientId?: string; // [核心修改] 客户端可传入已存在原料的ID
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
export class DoughIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string; // name 字段用于创建新原料或关联预制/附加配方

    // [核心修改] ratio 现在应为小数形式 (例如: 92% 应传入 0.92)
    @IsNumber()
    @IsNotEmpty()
    ratio: number;

    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    // [核心修改] waterContent 现在应为小数形式 (例如: 75% 应传入 0.75)
    @IsNumber()
    @IsOptional()
    waterContent?: number;

    @IsUUID()
    @IsOptional()
    ingredientId?: string; // [核心修改] 客户端可传入已存在原料的ID
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

    // [核心修改] lossRatio 应为小数形式 (例如: 2% 应传入 0.02)
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
