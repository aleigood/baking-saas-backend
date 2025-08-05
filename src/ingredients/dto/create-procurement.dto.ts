import { IsDateString, IsInt, IsNotEmpty, IsNumber } from 'class-validator';

export class CreateProcurementDto {
    @IsInt()
    @IsNotEmpty()
    packagesPurchased: number;

    @IsNumber()
    @IsNotEmpty()
    pricePerPackage: number;

    @IsDateString()
    @IsNotEmpty()
    purchaseDate: string;
}
