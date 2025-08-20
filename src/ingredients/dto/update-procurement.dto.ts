import { IsDateString, IsNumber, IsOptional } from 'class-validator';

/**
 * [新增] 用于修改采购记录的DTO
 */
export class UpdateProcurementDto {
    @IsNumber()
    @IsOptional()
    pricePerPackage?: number;

    @IsDateString()
    @IsOptional()
    purchaseDate?: string;
}
