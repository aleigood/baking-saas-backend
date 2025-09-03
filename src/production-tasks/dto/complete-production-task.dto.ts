import { Type } from 'class-transformer';
import {
    IsArray,
    IsInt,
    IsNotEmpty,
    IsOptional,
    IsPositive,
    IsString,
    IsUUID,
    ValidateNested,
    Min,
} from 'class-validator';

/**
 * [核心新增] 用于定义每个损耗项的详细信息
 */
class SpoilageDetailDto {
    @IsString()
    @IsNotEmpty()
    stage: string;

    @IsInt()
    @IsPositive()
    quantity: number;

    @IsString()
    @IsOptional()
    notes?: string; // 可选的附加说明
}

/**
 * [核心修改] 用于定义每个产品的实际完成情况
 */
class CompletedTaskItemDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsInt()
    @Min(0) // 实际完成数量可以为0
    @IsNotEmpty()
    completedQuantity: number;

    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => SpoilageDetailDto)
    spoilageDetails?: SpoilageDetailDto[];
}

/**
 * [核心修改] 完成生产任务的DTO，现在基于“实际完成数量”
 */
export class CompleteProductionTaskDto {
    @IsString()
    @IsOptional()
    notes?: string; // 生产日志的备注

    /**
     * [核心修改] 提交每个产品的实际完成项列表
     */
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CompletedTaskItemDto)
    completedItems: CompletedTaskItemDto[];
}
