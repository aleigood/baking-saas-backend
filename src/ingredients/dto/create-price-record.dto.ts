import { IsNotEmpty, IsNumber, IsPositive } from 'class-validator';

export class CreatePriceRecordDto {
    @IsNumber()
    @IsPositive()
    @IsNotEmpty()
    packageCount!: number;

    @IsNumber()
    @IsPositive()
    @IsNotEmpty()
    pricePerPackage!: number;
}
