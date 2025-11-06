import {
    IsString,
    IsNotEmpty,
    IsArray,
    ValidateNested,
    IsOptional, // [核心修改] 导入 IsOptional
    IsNumber,
    IsEnum,
    IsBoolean,
    IsUUID,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductIngredientType, RecipeCategory, RecipeType } from '@prisma/client'; // [核心修改] 导入 RecipeCategory

// [核心修正] 导出 ProductIngredientDto 以在其他文件中使用
// 用于产品中附加原料（搅拌、馅料、装饰）的DTO
export class ProductIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string; // name 字段用于创建新原料或关联预制/附加配方

    // [核心修改] 将 type 字段变为可选
    @IsEnum(ProductIngredientType)
    @IsOptional() // 添加 @IsOptional()
    // @IsNotEmpty() // 移除 @IsNotEmpty()
    type?: ProductIngredientType; // 'MIX_IN', 'FILLING', 'TOPPING'

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

    // [核心新增] 补充 isFlour 字段，以匹配 _ensureIngredientsExist 逻辑
    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    // [核心新增] 补充 waterContent 字段，以匹配 _ensureIngredientsExist 逻辑
    @IsNumber()
    @IsOptional()
    waterContent?: number;
}

// [核心修正] 导出 ProductDto 以在其他文件中使用
// 用于最终产品的DTO
export class ProductDto {
    @IsUUID()
    @IsOptional()
    id?: string; // [核心新增] 增加产品ID字段，用于更新时匹配

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

// [核心重命名] DoughIngredientDto -> ComponentIngredientDto
// 用于配方组件中原料的DTO
export class ComponentIngredientDto {
    @IsString()
    @IsNotEmpty()
    name: string; // name 字段用于创建新原料或关联预制/附加配方

    // 对于预制面团，此字段将由后端计算，前端无需提供。
    @IsNumber()
    @IsOptional()
    ratio?: number;

    // [核心新增] 用于预制面团的意图字段，例如传入 0.08 代表使用主面团8%的面粉制作该预制面团。
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

    // [核心新增] 增加 category 字段，允许前端指定配方品类
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

    // [核心新增] 新增分割定额损耗字段，与 lossRatio 平级
    @IsNumber()
    @IsOptional()
    divisionLoss?: number;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ComponentIngredientDto) // [核心重命名] DoughIngredientDto -> ComponentIngredientDto
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
