import { IsEnum, IsOptional } from 'class-validator';
import { Role, UserStatus } from '@prisma/client';

export class UpdateMemberDto {
  @IsEnum(Role)
  @IsOptional()
  role?: Role;

  @IsEnum(UserStatus)
  @IsOptional()
  status?: UserStatus;
}
