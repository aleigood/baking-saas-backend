import { IsNotEmpty, IsString } from 'class-validator';

/**
 * [V2.1 DTO 变更]
 * 用于设置激活SKU的DTO。
 * 原来的 SetDefaultSkuDto 已被此类替换。
 */
export class SetActiveSkuDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;
}
