import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

/**
 * [已恢复并适配] 用于新用户注册并创建店铺的DTO
 */
export class RegisterDto {
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
