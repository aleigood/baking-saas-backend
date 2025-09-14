// 文件路径: src/auth/dto/auth.dto.ts
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

/**
 * [修改] 用于新用户注册并创建店铺的DTO
 */
export class RegisterDto {
    @IsString()
    @IsNotEmpty()
    name: string; // [新增] 用户姓名

    @IsString()
    @IsNotEmpty()
    phone: string;

    @IsString()
    @IsNotEmpty()
    password: string;

    @IsString()
    @IsNotEmpty()
    tenantName: string;
}

/**
 * [已恢复并适配] 用于手机号密码登录的DTO
 */
export class AuthDto {
    @IsString()
    @IsNotEmpty()
    phone: string;

    @IsString()
    @IsNotEmpty()
    password: string;
}

/**
 * [已恢复] 用于微信登录的DTO
 */
export class WechatLoginDto {
    @IsString()
    @IsNotEmpty()
    code: string;

    @IsString()
    @IsOptional()
    invitationCode?: string;
}

/**
 * [核心新增] 定义登录成功后返回给客户端的数据结构。
 */
export class LoginResponseDto {
    accessToken: string;
    redirectTo?: string; // 可选的重定向路径
}
