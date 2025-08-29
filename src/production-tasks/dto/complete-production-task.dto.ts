import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, IsUUID, ValidateNested } from 'class-validator';

/**
 * [核心新增] 用于定义损耗项的 DTO
 * (New: DTO for defining each loss item)
 */
class ProductionLossDto {
    @IsUUID()
    @IsNotEmpty()
    productId: string;

    @IsString()
    @IsNotEmpty()
    stage: string;

    @IsInt()
    @IsPositive()
    quantity: number;
}

/**
 * [修改] 完成生产任务的数据传输对象
 * (Modified: Data Transfer Object for completing a production task)
 */
export class CompleteProductionTaskDto {
    @IsString()
    @IsOptional()
    notes?: string; // 生产日志的备注 (Notes for the production log)

    /**
     * [核心新增] 损耗的产品列表
     * (New: List of spoiled products)
     */
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => ProductionLossDto)
    losses?: ProductionLossDto[];
}
