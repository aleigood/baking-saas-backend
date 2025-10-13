/**
 * 文件路径: src/production-tasks/dto/preparation.dto.ts
 * 文件描述: [新增] 定义所有与生产准备工作相关的 DTO，包括备料清单和预制件任务。
 */
import { CalculatedRecipeDetails } from '../../costing/costing.service';

// 备料清单中的单个物料项
export interface BillOfMaterialsItem {
    ingredientId: string;
    ingredientName: string;
    totalRequired: number; // 总需求量 (g)
    currentStock?: number; // 当前库存 (g)，仅标准原料有
    suggestedPurchase: number; // 建议采购量 (g)
}

// 备料清单接口的完整响应体
export interface BillOfMaterialsResponseDto {
    standardItems: BillOfMaterialsItem[];
    nonInventoriedItems: BillOfMaterialsItem[];
}

// 统一的前置准备任务接口
export interface PrepTask {
    id: string;
    title: string;
    details: string;
    items: CalculatedRecipeDetails[]; // 需要制作的预制件列表
    billOfMaterials?: BillOfMaterialsResponseDto; // 需要采购的原料清单
}
