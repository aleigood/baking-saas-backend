import { IsNotEmpty, IsString, MinLength } from 'class-validator';

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
}
