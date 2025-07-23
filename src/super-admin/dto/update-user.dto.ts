/**
 * 文件路径: src/super-admin/dto/update-user.dto.ts
 * 文件描述: [新增] 定义超级管理员更新用户信息时所需的数据结构。
 */
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateUserDto {
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  name?: string;

  // 未来可以扩展更多可编辑字段，如重置密码等
}
