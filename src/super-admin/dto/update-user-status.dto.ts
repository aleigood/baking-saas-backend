/**
 * 文件路径: src/super-admin/dto/update-user-status.dto.ts
 * 文件描述: [新增] 定义更新用户状态时所需的数据结构。
 */
import { IsEnum, IsNotEmpty } from 'class-validator';
import { UserStatus } from '@prisma/client';

export class UpdateUserStatusDto {
  @IsEnum(UserStatus)
  @IsNotEmpty()
  status: UserStatus;
}
