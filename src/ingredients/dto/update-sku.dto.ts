/**
 * 文件路径: src/ingredients/dto/update-sku.dto.ts
 * 文件描述: [新增] 用于更新 SKU 信息的 DTO，所有字段均为可选。
 */
import { IsString, IsOptional, IsNumber, IsPositive } from 'class-validator';

export class UpdateSkuDto {
    @IsString()
    @IsOptional()
    brand?: string;

    @IsString()
    @IsOptional()
    specName?: string;

    @IsNumber()
    @IsPositive()
    @IsOptional()
    specWeightInGrams?: number;
}
