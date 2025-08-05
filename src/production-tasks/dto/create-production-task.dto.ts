import {
    IsString,
    IsNotEmpty,
    IsUUID,
    IsOptional,
    IsDateString,
    IsArray,
    ValidateNested,
    IsInt, // [修改] 导入 IsInt 验证器
} from 'class-validator';
import { Type } from 'class-transformer';

// [修改] 用于定义任务中每个产品项的 DTO
// (Modified: DTO for defining each product item in a task)
class ProductionTaskItemDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsInt() // [修改] 确保数量是整数 (Ensure quantity is an integer)
    @IsNotEmpty()
    quantity: number;

    // [移除] unit 字段已被删除
    // (Removed: unit field has been deleted)
    // @IsString()
    // @IsNotEmpty()
    // unit: string;
}

/**
 * [修改] 创建生产任务的数据传输对象
 * (Modified: Data Transfer Object for creating a production task)
 */
export class CreateProductionTaskDto {
    @IsDateString()
    @IsNotEmpty()
    plannedDate: string; // 计划生产日期 (Planned production date)

    @IsString()
    @IsOptional()
    notes?: string; // 备注 (Notes)

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductionTaskItemDto)
    products: ProductionTaskItemDto[]; // [修改] 从单个产品变为产品数组 (Changed: from a single product to an array of products)
}
