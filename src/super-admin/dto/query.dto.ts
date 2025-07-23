/**
 * 文件路径: src/super-admin/dto/query.dto.ts
 * 文件描述: [新增] 定义分页、搜索和排序的查询参数 DTO。
 */
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class PaginationQueryDto {
  @IsOptional()
  @IsInt({ message: '页码必须是整数' })
  @Type(() => Number)
  @Min(1, { message: '页码不能小于1' })
  page?: number = 1;

  @IsOptional()
  @IsInt({ message: '每页数量必须是整数' })
  @Type(() => Number)
  @Min(1, { message: '每页数量不能小于1' })
  limit?: number = 10;

  @IsOptional()
  @IsString({ message: '搜索词必须是字符串' })
  search?: string;

  @IsOptional()
  @IsString({ message: '排序字段必须是字符串' })
  // 格式示例: "name:asc" 或 "createdAt:desc"
  sortBy?: string;
}
