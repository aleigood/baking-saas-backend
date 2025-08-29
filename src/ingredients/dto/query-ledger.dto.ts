/**
 * 文件路径: src/ingredients/dto/query-ledger.dto.ts
 * 文件描述: [新增] 定义获取库存流水时所需的分页参数。
 */
import { IsNumberString, IsOptional } from 'class-validator';

export class QueryLedgerDto {
    @IsNumberString()
    @IsOptional()
    page?: string;

    @IsNumberString()
    @IsOptional()
    limit?: string;
}
