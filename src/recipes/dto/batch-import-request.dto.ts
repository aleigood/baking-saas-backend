import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsUUID } from 'class-validator';

export class BatchImportRequestDto {
    /**
     * 要导入的店铺ID列表。
     * 如果为空或未提供，则默认为当前用户拥有的所有店铺。
     */
    @IsArray()
    @IsOptional()
    @IsUUID('all', { each: true })
    // [修复] 简化并使 Transform 逻辑类型安全
    @Transform(({ value }: { value: string | string[] }) => {
        if (typeof value === 'string') {
            // 将 "id1,id2,id3" 这种格式的字符串转换为数组，并过滤掉可能的空字符串
            return value.split(',').filter((id) => id.trim() !== '');
        }
        // 如果已经是数组或其他类型，直接返回
        return value;
    })
    tenantIds?: string[];
}
