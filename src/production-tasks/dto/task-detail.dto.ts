/**
 * 文件路径: src/production-tasks/dto/task-detail.dto.ts
 * 文件描述: [新增] 定义任务详情接口返回的专用数据结构。
 */
import { ProductionTaskStatus } from '@prisma/client';
import { PrepTask } from '../production-tasks.service';

// 定义原料详情的数据结构
export interface TaskIngredientDetail {
    id: string;
    name: string;
    brand: string | null;
    weightInGrams: number;
}

// 定义面团汇总中每个产品的数据结构
export interface DoughProductSummary {
    id: string;
    name: string;
    quantity: number;
    totalBaseDoughWeight: number;
    divisionWeight: number; // 分割重量
}

// 定义单个产品的详细信息（如辅料、馅料等）
export interface ProductDetails {
    id: string;
    name: string;
    mixIns: TaskIngredientDetail[];
    fillings: TaskIngredientDetail[];
    procedure: string[];
}

// 定义按面团类型分组的数据结构
export interface DoughGroup {
    familyId: string;
    familyName: string;
    productsDescription: string;
    totalDoughWeight: number;
    mainDoughIngredients: TaskIngredientDetail[];
    mainDoughProcedure: string[];
    products: DoughProductSummary[];
    productDetails: ProductDetails[];
}

// 定义用于完成任务模态框的产品列表项
export interface TaskCompletionItem {
    id: string;
    name: string;
    plannedQuantity: number;
}

// 最终的任务详情接口响应体
export interface TaskDetailResponseDto {
    id: string;
    status: ProductionTaskStatus;
    notes: string | null;
    stockWarning: string | null;
    prepTask: PrepTask | null;
    doughGroups: DoughGroup[];
    items: TaskCompletionItem[];
}
