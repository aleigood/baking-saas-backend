/**
 * 文件路径: src/members/dto/update-member.dto.ts
 * 文件描述: 定义了更新成员角色所需的数据结构。
 */
import { IsEnum, IsNotEmpty } from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateMemberRoleDto {
  @IsEnum(Role)
  @IsNotEmpty()
  role: Role;
}
