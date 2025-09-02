/**
 * 文件路径: src/recipes/dto/recipe-form-template.dto.ts
 * 文件描述: [新增] 定义用于“创建新版本”时，由后端生成的配方表单模板的数据结构。
 */

// [核心修复] 导出接口以供其他模块使用
// 定义子原料（如辅料、馅料、表面装饰）的类型
export interface SubIngredientTemplate {
    id: string | null;
    ratio: number | null;
    weightInGrams?: number | null;
}

// [核心修复] 导出接口以供其他模块使用
// 定义产品模板的类型
export interface ProductTemplate {
    name: string;
    baseDoughWeight: number;
    mixIns: SubIngredientTemplate[];
    fillings: SubIngredientTemplate[];
    toppings: SubIngredientTemplate[];
    procedure: string[];
}

// [核心修复] 导出接口以供其他模块使用
// 定义面团中原料的模板类型
export interface DoughIngredientTemplate {
    id: string | null;
    name: string;
    ratio: number | null;
}

// [核心修复] 导出接口以供其他模块使用
// 定义面团模板的类型
export interface DoughTemplate {
    id: string;
    name: string;
    type: 'MAIN_DOUGH' | 'PRE_DOUGH';
    lossRatio?: number;
    flourRatioInMainDough?: number; // 仅 PRE_DOUGH 类型需要
    ingredients: DoughIngredientTemplate[];
    procedure: string[];
}

// 顶层配方表单模板的 DTO
export class RecipeFormTemplateDto {
    name: string;
    type: 'MAIN';
    notes: string; // 新版本的备注，默认为空
    doughs: DoughTemplate[];
    products: ProductTemplate[];
}
