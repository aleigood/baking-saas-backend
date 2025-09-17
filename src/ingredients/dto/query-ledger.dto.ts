/**
 * 文件路径: src/ingredients/dto/query-ledger.dto.ts
 * 文件描述: [修改] 新增流水类型、操作人、日期范围和关键字查询参数。
 */
import { IsDateString, IsEnum, IsNumberString, IsOptional, IsString, IsUUID } from 'class-validator';

// [核心新增] 定义流水类型的枚举
export enum LedgerEntryType {
    PROCUREMENT = '采购入库',
    CONSUMPTION = '生产消耗',
    ADJUSTMENT = '库存调整',
    SPOILAGE = '生产损耗',
}

// [核心新增] 为流水账条目定义一个明确的、可导出的类型接口
export interface LedgerEntry {
    date: Date;
    type: string;
    change: number;
    details: string;
    operator: string;
}

export class QueryLedgerDto {
    @IsNumberString()
    @IsOptional()
    page?: string;

    @IsNumberString()
    @IsOptional()
    limit?: string;

    // --- [核心新增] 新增的查询参数 ---

    @IsEnum(LedgerEntryType)
    @IsOptional()
    type?: LedgerEntryType; // 按流水类型筛选

    @IsUUID()
    @IsOptional()
    userId?: string; // 按操作人ID筛选

    @IsDateString()
    @IsOptional()
    startDate?: string; // 按开始日期筛选

    @IsDateString()
    @IsOptional()
    endDate?: string; // 按结束日期筛选

    @IsString()
    @IsOptional()
    keyword?: string; // 按关键字筛选
}
