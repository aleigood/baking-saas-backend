import { IsNotEmpty, IsNumber, IsPositive } from 'class-validator'; // [核心修改] 移除不再需要的导入

export class CreateProcurementDto {
    @IsNumber()
    @IsPositive() // [核心新增] 保留数据验证，确保采购数量为正数
    @IsNotEmpty()
    packagesPurchased: number;

    @IsNumber()
    @IsPositive() // [核心新增] 保留数据验证，确保采购单价为正数
    @IsNotEmpty()
    pricePerPackage: number;
}
