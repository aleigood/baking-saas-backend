/**
 * 文件路径: src/ingredients/dto/create-procurement.dto.ts
 * 文件描述: 定义了为某个SKU添加入库（采购）记录所需的数据结构。
 */
export class CreateProcurementDto {
  packagesPurchased: number; // 采购了多少包
  pricePerPackage: number; // 当时的每包单价
}
