import { Type } from 'class-transformer';
import {
    IsArray,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
    ValidateNested,
    Min,
    IsNumber, // [修改]
} from 'class-validator';

/**
 * [核心新增] 用于定义每个损耗项的详细信息
 */
class SpoilageDetailDto {
    @IsString()
    @IsNotEmpty()
    stage: string;

    @IsNumber() // [核心修改] 支持小数损耗 (克重)
    @Min(0)
    quantity: number;

    @IsString()
    @IsOptional()
    notes?: string;
}

/**
 * [核心修改] 用于定义每个产品的实际完成情况
 */
class CompletedTaskItemDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsNumber() // [核心修改] 支持小数产出 (克重)
    @Min(0)
    @IsNotEmpty()
    completedQuantity: number;

    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => SpoilageDetailDto)
    spoilageDetails?: SpoilageDetailDto[];
}

/**
 * [核心修改] 完成生产任务的DTO
 */
export class CompleteProductionTaskDto {
    @IsString()
    @IsOptional()
    notes?: string;

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => CompletedTaskItemDto)
    completedItems: CompletedTaskItemDto[];
}
