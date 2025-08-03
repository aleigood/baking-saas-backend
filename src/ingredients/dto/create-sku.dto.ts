/**
 * 文件路径: src/ingredients/dto/create-sku.dto.ts
 * 文件描述: (已重构) 添加了完整的 class-validator 验证装饰器。
 */
import { IsString, IsNotEmpty, IsNumber, IsPositive, IsOptional } from 'class-validator';

export class CreateSkuDto {
    @IsString()
    @IsOptional()
    brand?: string;

    @IsString()
    @IsNotEmpty()
    specName: string;

    @IsNumber()
    @IsPositive()
    specWeightInGrams: number;
}
