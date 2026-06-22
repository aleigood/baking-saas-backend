// 文件路径: src/auth/dto/auth.dto.ts
import { IsString, IsNotEmpty, IsOptional, Matches, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * [修改] 用于新用户注册并创建店铺的DTO
 */
export class RegisterDto {
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

/**
 * [已恢复并适配] 用于手机号密码登录的DTO
 */
export class AuthDto {
    @IsString()
    @IsNotEmpty()
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
    @Matches(/^1\d{10}$/, { message: '请输入正确的11位手机号' })
    phone!: string;

    @IsString()
    @IsNotEmpty()
    password!: string;
}

/**
 * [已恢复] 用于微信登录的DTO
 */
export class WechatLoginDto {
    @IsString()
    @IsNotEmpty()
    code!: string;

    @IsString()
    @IsOptional()
    invitationCode?: string;
}

export class BindWechatDto {
    @IsString()
    @IsNotEmpty()
    code!: string;
}

/**
 * [核心新增] 定义登录成功后返回给客户端的数据结构。
 */
export class LoginResponseDto {
    accessToken!: string;
    redirectTo?: string; // 可选的重定向路径
}
