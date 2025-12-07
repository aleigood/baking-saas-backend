import {
    IsString,
    IsNotEmpty,
    IsUUID,
    IsOptional,
    IsDateString,
    IsArray,
    ValidateNested,
    IsNumber, // [修改] 导入 IsNumber
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// [修改] 用于定义任务中每个产品项的 DTO
class ProductionTaskItemDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsNumber() // [核心修改] 改为 IsNumber 以支持小数 (原料重量)
    @Min(0.001) // [新增] 确保大于0
    @IsNotEmpty()
    quantity: number;
}

/**
 * [修改] 创建生产任务的数据传输对象
 */
export class CreateProductionTaskDto {
    @IsDateString()
    @IsNotEmpty()
    startDate: string;

    @IsDateString()
    @IsOptional()
    endDate?: string;

    @IsString()
    @IsOptional()
    notes?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductionTaskItemDto)
    products: ProductionTaskItemDto[];
}
