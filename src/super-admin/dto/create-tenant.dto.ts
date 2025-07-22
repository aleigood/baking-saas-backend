/**
 * 文件路径: src/super-admin/dto/create-tenant.dto.ts
 * 文件描述: [新增] 定义创建店铺时所需的数据结构。
 */
import { IsString, IsNotEmpty } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @IsNotEmpty()
  name: string;
}
