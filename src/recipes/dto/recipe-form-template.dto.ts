/**
 * 文件路径: src/recipes/dto/recipe-form-template.dto.ts
 * 文件描述: [核心修改] 更新 DTO 以支持所有配方类型
 */

import { RecipeCategory, RecipeType } from '@prisma/client'; // [核心修改] 导入 RecipeCategory

export interface SubIngredientTemplate {
    id: string | null;
    name: string;
    ratio: number | null;
    weightInGrams?: number | null;
    isRecipe: boolean; // [核心新增] 新增字段，用于区分是基础原料还是子配方
    isFlour?: boolean; // [核心新增] 新增字段，标识是否为面粉
    waterContent?: number; // [核心新增] 新增字段，标识含水量
}

export interface ProductTemplate {
    name: string;
    baseDoughWeight: number;
    mixIns: SubIngredientTemplate[];
    fillings: SubIngredientTemplate[];
    toppings: SubIngredientTemplate[];
    procedure: string[];
}

export interface DoughTemplate {
    id: string;
    name: string;
    type: 'MAIN_DOUGH' | 'PRE_DOUGH';
    lossRatio?: number;
    flourRatioInMainDough?: number;
    ingredients: DoughIngredientTemplate[];
    procedure: string[];
}

export interface DoughIngredientTemplate {
    id: string | null;
    name: string;
    ratio: number | null;
    isRecipe: boolean; // [核心新增] 新增字段，用于区分是基础原料还是子配方
    isFlour?: boolean; // [核心新增] 新增字段，标识是否为面粉
    waterContent?: number; // [核心新增] 新增字段，标识含水量
}

// [核心修改] 更新顶层 DTO 以支持所有类型，并使 ingredients 和 procedure 可选
export class RecipeFormTemplateDto {
    name: string;
    type: RecipeType; // 使用枚举，更灵活
    category?: RecipeCategory; // [核心新增] 增加 category 字段，使其可以在编辑时传递给前端
    notes: string;
    // [核心修复] 新增 targetTemp 字段以匹配 service 层的返回数据
    targetTemp?: number;
    doughs?: DoughTemplate[]; // 主配方使用 (保持 `doughs` 命名以最小化对前端的冲击)
    products?: ProductTemplate[]; // 主配方使用
    ingredients?: DoughIngredientTemplate[]; // 其他配方使用
    procedure?: string[]; // 其他配方使用
}
