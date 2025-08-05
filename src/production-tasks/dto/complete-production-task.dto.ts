import { IsOptional, IsString } from 'class-validator';

/**
 * [修改] 完成生产任务的数据传输对象
 * (Modified: Data Transfer Object for completing a production task)
 */
export class CompleteProductionTaskDto {
    // [移除] actualQuantity 字段已被删除，因为业务逻辑是任务完成即代表计划完成
    // (Removed: actualQuantity field is deleted as task completion implies plan completion)
    // @IsNumber()
    // @IsNotEmpty()
    // actualQuantity: number;

    @IsString()
    @IsOptional()
    notes?: string; // 生产日志的备注 (Notes for the production log)
}
