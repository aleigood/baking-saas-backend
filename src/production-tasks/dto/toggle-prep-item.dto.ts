/**
 * 文件路径: src/production-tasks/dto/toggle-prep-item.dto.ts
 * 文件描述: [新增] 用于前置任务勾选切换的数据传输对象
 */
import { IsNotEmpty, IsUUID, IsBoolean, IsDateString, IsArray, IsOptional } from 'class-validator';

export class TogglePrepItemDto {
    @IsDateString()
    @IsNotEmpty()
    date!: string;

    @IsUUID()
    @IsNotEmpty()
    recipeFamilyId!: string;

    @IsBoolean()
    @IsNotEmpty()
    completed!: boolean;

    @IsArray()
    @IsOptional()
    @IsUUID(undefined, { each: true })
    taskIds?: string[];
}
