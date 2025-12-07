/**
 * 文件路径: src/production-tasks/dto/update-task-details.dto.ts
 * 文件描述: [修改] 支持小数数量（用于原料制作的重量）。
 */
import {
    IsString,
    IsNotEmpty,
    IsUUID,
    IsOptional,
    IsDateString,
    IsArray,
    ValidateNested,
    IsNumber, // [修改]
    Min,
} from 'class-validator';
import { Type } from 'class-transformer';

// 定义任务中每个产品项的 DTO
class ProductionTaskItemDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsNumber() // [核心修改] 改为 IsNumber
    @Min(0.001)
    @IsNotEmpty()
    quantity: number;
}

// 定义更新任务详情的 DTO
export class UpdateTaskDetailsDto {
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
