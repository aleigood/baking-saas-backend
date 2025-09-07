/**
 * 文件路径: src/ingredients/dto/adjust-stock.dto.ts
 * 文件描述: [修改] 新增 initialCostPerKg 字段，用于处理期初库存的成本录入。
 */
import { IsNumber, IsNotEmpty, IsString, IsOptional, IsPositive } from 'class-validator';

export class AdjustStockDto {
    @IsNumber()
    @IsNotEmpty()
    changeInGrams: number; // 正数代表盘盈增加, 负数代表损耗减少

    @IsString()
    @IsOptional()
    reason?: string; // 调整原因

    // [核心新增] 新增可选字段，仅在期初入库（库存从0开始增加）时使用
    @IsNumber()
    @IsPositive()
    @IsOptional()
    initialCostPerKg?: number; // 期初单价 (元/kg)
}
