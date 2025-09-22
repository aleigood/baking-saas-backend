/**
 * 文件路径: src/recipes/dto/recipe-form-template.dto.ts
 * 文件描述: [核心修改] 更新 DTO 以支持所有配方类型
 */

import { RecipeCategory, RecipeType } from '@prisma/client';

export interface SubIngredientTemplate {
    id: string | null;
    name: string;
    ratio: number | null;
    weightInGrams?: number | null;
    isRecipe: boolean;
    isFlour?: boolean;
    waterContent?: number;
}

export interface ProductTemplate {
    name: string;
    baseDoughWeight: number;
    mixIns: SubIngredientTemplate[];
    fillings: SubIngredientTemplate[];
    toppings: SubIngredientTemplate[];
    procedure: string[];
}

// [核心重命名] DoughIngredientTemplate -> ComponentIngredientTemplate
export interface ComponentIngredientTemplate {
    id: string | null;
    name: string;
    ratio: number | null;
    isRecipe: boolean;
    isFlour?: boolean;
    waterContent?: number;
}

// [核心重命名] DoughTemplate -> ComponentTemplate
export interface ComponentTemplate {
    id: string;
    name: string;
    type: 'MAIN_DOUGH' | 'PRE_DOUGH' | 'BASE_COMPONENT'; // 新增 BASE_COMPONENT 类型
    lossRatio?: number;
    flourRatioInMainDough?: number;
    ingredients: ComponentIngredientTemplate[];
    procedure: string[];
}

// [核心修改] 更新顶层 DTO，使用 components 替代 doughs
export class RecipeFormTemplateDto {
    name: string;
    type: RecipeType;
    category?: RecipeCategory;
    notes: string;
    targetTemp?: number;
    components: ComponentTemplate[]; // [核心重命名] doughs -> components
    products?: ProductTemplate[];
    // [核心移除] 以下两个字段的数据将被移入唯一的 component 中
    // ingredients?: ComponentIngredientTemplate[];
    // procedure?: string[];
}
