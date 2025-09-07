import { IsInt, IsNotEmpty, IsNumber, IsString } from 'class-validator';

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
}
