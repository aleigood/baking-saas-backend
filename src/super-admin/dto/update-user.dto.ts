import { IsEnum, IsOptional, IsString as IsStringForUpdate } from 'class-validator';
import { GlobalRole, UserStatus } from '@prisma/client';

export class UpdateUserDto {
    @IsStringForUpdate()
    @IsOptional()
    name?: string; // [修改] 用户姓名现在是可编辑字段

    @IsStringForUpdate()
    @IsOptional()
    phone?: string;

    @IsStringForUpdate()
    @IsOptional()
    password?: string;

    @IsEnum(GlobalRole)
    @IsOptional()
    globalRole?: GlobalRole;

    @IsEnum(UserStatus)
    @IsOptional()
    status?: UserStatus;
}
