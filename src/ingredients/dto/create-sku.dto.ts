/**
 * 文件路径: src/ingredients/dto/create-sku.dto.ts
 * 文件描述: 定义了为原料品类添加新SKU所需的数据结构。
 */
export class CreateSkuDto {
  brand?: string;
  specName: string; // 如 "500g袋装"
  specWeightInGrams: number;
}
