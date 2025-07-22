/**
 * 文件路径: src/ingredients/dto/set-default-sku.dto.ts
 * 文件描述: 定义了设置默认SKU所需的数据结构。
 */
import { IsString, IsNotEmpty } from 'class-validator';

export class SetDefaultSkuDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;
}
