/**
 * 文件路径: src/ingredients/dto/update-stock.dto.ts
 * 文件描述: [新增] 定义更新原料库存时所需的数据结构。
 */
import { IsNumber, IsNotEmpty, IsPositive } from 'class-validator';

export class UpdateStockDto {
    @IsNumber()
    @IsNotEmpty()
    @IsPositive()
    currentStockInGrams: number;
}
