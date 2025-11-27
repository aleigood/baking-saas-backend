/**
 * 文件路径: src/recipes/dto/recipe-form-template.dto.ts
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

export interface ComponentIngredientTemplate {
    id: string | null;
    name: string;
    ratio: number | null;
    isRecipe: boolean;
    isFlour?: boolean;
    waterContent?: number;
}

export interface ComponentTemplate {
    id: string;
    name: string;
    type: 'MAIN_DOUGH' | 'PRE_DOUGH' | 'BASE_COMPONENT';
    lossRatio?: number;
    divisionLoss?: number;
    flourRatioInMainDough?: number;

    // [核心新增] 自定义含水量 (用于回显)
    customWaterContent?: number;

    ingredients: ComponentIngredientTemplate[];
    procedure: string[];
}

export class RecipeFormTemplateDto {
    name: string;
    type: RecipeType;
    category?: RecipeCategory;
    notes: string;
    targetTemp?: number;
    components: ComponentTemplate[];
    products?: ProductTemplate[];
}
