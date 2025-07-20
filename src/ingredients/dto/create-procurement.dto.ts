import { IsInt, IsNotEmpty, IsNumber, IsString } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/library';

export class CreateProcurementDto {
  @IsInt()
  @IsNotEmpty()
  packagesPurchased: number;

  @IsNumber()
  @IsNotEmpty()
  pricePerPackage: Decimal;

  @IsString()
  @IsNotEmpty()
  skuId: string;
}
