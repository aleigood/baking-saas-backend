import { Type } from 'class-transformer';
import { IsDate, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

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

    // 将采购日期设为可选，以支持补录功能
    // 如果前端不传递此字段，后端将使用当前时间
    @IsOptional()
    @IsDate()
    @Type(() => Date)
    purchaseDate?: Date;
}
