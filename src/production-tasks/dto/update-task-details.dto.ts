/**
 * 文件路径: src/production-tasks/dto/update-task-details.dto.ts
 * 文件描述: [新增] 定义修改一个未开始的生产任务时所需的数据结构。
 */
import {
    IsString,
    IsNotEmpty,
    IsUUID,
    IsOptional,
    IsDateString,
    IsArray,
    ValidateNested,
    IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

// 定义任务中每个产品项的 DTO
class ProductionTaskItemDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsInt()
    @IsNotEmpty()
    quantity: number;
}

// 定义更新任务详情的 DTO
export class UpdateTaskDetailsDto {
    @IsDateString()
    @IsNotEmpty()
    startDate: string; // 开始日期

    @IsDateString()
    @IsOptional()
    endDate?: string; // 结束日期

    @IsString()
    @IsOptional()
    notes?: string; // 备注

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => ProductionTaskItemDto)
    products: ProductionTaskItemDto[]; // 产品列表
}
