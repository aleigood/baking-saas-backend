/**
 * 文件路径: src/super-admin/dto/update-tenant.dto.ts
 * 文件描述: [新增] 定义更新店铺信息时所需的数据结构。
 */
import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { TenantStatus } from '@prisma/client';

export class UpdateTenantDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  @IsEnum(TenantStatus)
  @IsOptional()
  status?: TenantStatus;
}
