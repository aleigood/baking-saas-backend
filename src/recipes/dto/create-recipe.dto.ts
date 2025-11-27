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
import { ProductIngredientType, RecipeCategory, RecipeType } from '@prisma/client';

// 用于产品中附加原料（搅拌、馅料、装饰）的DTO
export class ProductIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(ProductIngredientType)
    @IsOptional()
    type?: ProductIngredientType;

    @IsNumber()
    @IsOptional()
    ratio?: number;

    @IsNumber()
    @IsOptional()
    weightInGrams?: number;

    @IsUUID()
    @IsOptional()
    ingredientId?: string;

    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    @IsNumber()
    @IsOptional()
    waterContent?: number;
}

// 用于最终产品的DTO
export class ProductDto {
    @IsUUID()
    @IsOptional()
    id?: string;

    @IsString()
    @IsNotEmpty()
    name: string;

    @IsNumber()
    @IsNotEmpty()
    weight: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductIngredientDto)
    @IsOptional()
    fillings?: ProductIngredientDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductIngredientDto)
    @IsOptional()
    mixIn?: ProductIngredientDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductIngredientDto)
    @IsOptional()
    toppings?: ProductIngredientDto[];

    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    procedure?: string[];
}

// 用于配方组件中原料的DTO
export class ComponentIngredientDto {
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

    @IsUUID()
    @IsOptional()
    ingredientId?: string;
}

// 主创建DTO
export class CreateRecipeDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsEnum(RecipeType)
    @IsOptional()
    type?: RecipeType;

    @IsEnum(RecipeCategory)
    @IsOptional()
    category?: RecipeCategory;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsNumber()
    @IsOptional()
    targetTemp?: number;

    @IsNumber()
    @IsOptional()
    lossRatio?: number;

    @IsNumber()
    @IsOptional()
    divisionLoss?: number;

    // [核心新增] 自定义含水量字段 (0-100)
    @IsNumber()
    @IsOptional()
    customWaterContent?: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ComponentIngredientDto)
    ingredients: ComponentIngredientDto[];

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
