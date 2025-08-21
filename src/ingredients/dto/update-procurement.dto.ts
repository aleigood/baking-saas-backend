import { IsNotEmpty, IsNumber } from 'class-validator';

export class UpdateProcurementDto {
    // 根据业务需求，只允许修改每包的价格
    @IsNumber()
    @IsNotEmpty()
    pricePerPackage: number;
}
