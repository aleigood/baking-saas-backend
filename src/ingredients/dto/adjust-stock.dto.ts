/**
 * 文件路径: src/ingredients/dto/adjust-stock.dto.ts
 * 文件描述: [新增] 定义库存调整时所需的数据结构。
 */
import { IsNumber, IsNotEmpty, IsString, IsOptional } from 'class-validator';

export class AdjustStockDto {
    @IsNumber()
    @IsNotEmpty()
    changeInGrams: number; // 正数代表盘盈增加, 负数代表损耗减少

    @IsString()
    @IsOptional()
    reason?: string; // 调整原因
}
