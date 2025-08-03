import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsString,
} from 'class-validator';

export class CreateProcurementDto {
  @IsString()
  @IsNotEmpty()
  skuId: string;

  @IsInt()
  @IsNotEmpty()
  packagesPurchased: number;

  @IsNumber()
  @IsNotEmpty()
  pricePerPackage: number;

  // 修复：添加 purchaseDate 字段
  @IsDateString()
  @IsNotEmpty()
  purchaseDate: string;
}
