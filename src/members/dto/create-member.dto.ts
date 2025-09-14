import { IsNotEmpty, IsString, MinLength, IsEnum } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateMemberDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    phone: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(3, { message: '密码至少需要3个字符' })
    password: string;

    @IsEnum(Role)
    @IsNotEmpty()
    role: Role; // [核心新增] 新增角色字段
}
