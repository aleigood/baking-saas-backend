import { IsNotEmpty, IsString, IsEnum } from 'class-validator';
import { Role } from '@prisma/client';
import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateMemberDto {
    @IsString()
    @IsNotEmpty()
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
    @Matches(/^1\d{10}$/, { message: '请输入正确的11位手机号' })
    phone!: string;

    @IsEnum(Role)
    @IsNotEmpty()
    role!: Role; // [核心新增] 新增角色字段
}
