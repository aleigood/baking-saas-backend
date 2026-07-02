import { IsOptional, IsString, Length, MaxLength, MinLength } from 'class-validator';
import { Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateMembershipApplicationDto {
    @IsString()
    @MinLength(20)
    token!: string;

    @IsString()
    @Length(1, 30)
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
    name!: string;

    @IsString()
    @Length(1, 30)
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value))
    wechatNickname!: string;

    @Matches(/^1\d{10}$/, { message: '请输入正确的手机号' })
    phone!: string;

    @IsOptional()
    @Matches(/^\d{6}$/, { message: '请输入6位短信验证码' })
    verificationCode?: string;

    @IsOptional()
    @IsString()
    @MaxLength(200)
    message?: string;
}
