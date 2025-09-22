/**
 * 文件路径: src/production-tasks/dto/task-detail.dto.ts
 * 文件描述: [核心重构] 将与“面团”相关的命名更新为通用的“组件”。
 */
import { ProductionTaskStatus, RecipeCategory } from '@prisma/client'; // [核心新增] 导入 RecipeCategory
import { PrepTask } from '../production-tasks.service';

// 定义原料详情的数据结构
export interface TaskIngredientDetail {
    id: string;
    name: string;
    brand: string | null;
    weightInGrams: number;
    isRecipe: boolean;
    extraInfo?: string | null;
}

// [核心重命名] DoughProductSummary -> ProductComponentSummary
// 定义组件汇总中每个产品的数据结构
export interface ProductComponentSummary {
    id: string;
    name: string;
    quantity: number;
    totalBaseComponentWeight: number; // [核心重命名] totalBaseDoughWeight -> totalBaseComponentWeight
    divisionWeight: number;
}

// 定义单个产品的详细信息（如辅料、馅料等）
export interface ProductDetails {
    id: string;
    name: string;
    mixIns: TaskIngredientDetail[];
    fillings: TaskIngredientDetail[];
    toppings: TaskIngredientDetail[];
    procedure: string[];
}

// [核心重命名] DoughGroup -> ComponentGroup
// 定义按组件类型分组的数据结构
export interface ComponentGroup {
    familyId: string;
    familyName: string;
    category: RecipeCategory; // [核心新增] 增加品类字段，用于驱动前端UI
    productsDescription: string;
    totalComponentWeight: number; // [核心重命名] totalDoughWeight -> totalComponentWeight
    baseComponentIngredients: TaskIngredientDetail[]; // [核心重命名] mainDoughIngredients -> baseComponentIngredients
    baseComponentProcedure: string[]; // [核心重命名] mainDoughProcedure -> baseComponentProcedure
    products: ProductComponentSummary[];
    productDetails: ProductDetails[];
}

// 定义用于完成任务模态框的产品列表项
export interface TaskCompletionItem {
    id: string;
    name: string;
    plannedQuantity: number;
}

// [核心重构] 最终的任务详情接口响应体
export interface TaskDetailResponseDto {
    id: string;
    status: ProductionTaskStatus;
    notes: string | null;
    stockWarning: string | null;
    prepTask: PrepTask | null;
    componentGroups: ComponentGroup[]; // [核心重命名] doughGroups -> componentGroups
    items: TaskCompletionItem[];
}
