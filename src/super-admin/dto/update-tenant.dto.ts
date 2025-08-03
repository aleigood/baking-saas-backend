import { IsString, IsOptional } from 'class-validator';

export class UpdateTenantDto {
  @IsString()
  @IsOptional()
  name?: string;

  // 修复：Tenant模型没有status字段，移除此项
}
