import { Type } from 'class-transformer';
import { IsDate, IsInt, IsNotEmpty, IsNumber, IsString } from 'class-validator';

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

    // [核心修改] 将采购日期从可选改为必需，确保时间戳总是由客户端提供
    @IsDate()
    @IsNotEmpty()
    @Type(() => Date)
    purchaseDate: Date;
}
