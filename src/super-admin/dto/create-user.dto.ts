import { IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateUserDto {
    @IsString()
    @IsNotEmpty()
    name!: string; // [新增] 用户姓名

    @IsString()
    @IsNotEmpty()
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
    @Matches(/^1\d{10}$/, { message: '请输入正确的11位手机号' })
    phone!: string;

    @IsString()
    @IsNotEmpty()
    @MinLength(8, { message: '密码至少需要8个字符' })
    password!: string;
}
