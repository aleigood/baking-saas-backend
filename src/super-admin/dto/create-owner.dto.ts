/**
 * 文件路径: src/super-admin/dto/create-owner.dto.ts
 * 文件描述: [新增] 定义创建老板账号时所需的数据结构。
 */
import { IsString, IsNotEmpty, IsEmail, IsUUID } from 'class-validator';

export class CreateOwnerDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsUUID()
  @IsNotEmpty()
  tenantId: string;
}
