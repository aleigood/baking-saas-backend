import { IsEnum, IsOptional, IsString as IsStringForUpdate } from 'class-validator';
import { Role, UserStatus } from '@prisma/client';

export class UpdateUserDto {
    @IsStringForUpdate()
    @IsOptional()
    name?: string; // [新增] 用户姓名

    @IsStringForUpdate()
    @IsOptional()
    phone?: string;

    @IsStringForUpdate()
    @IsOptional()
    password?: string;

    @IsEnum(Role)
    @IsOptional()
    role?: Role;

    @IsEnum(UserStatus)
    @IsOptional()
    status?: UserStatus;
}
