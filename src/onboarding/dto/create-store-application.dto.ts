import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateStoreApplicationDto {
    @IsString()
    @Length(2, 60)
    storeName!: string;

    @IsString()
    @Length(2, 200)
    address!: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    @IsString()
    @Length(2, 30)
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
    name!: string;

    @Matches(/^1\d{10}$/, { message: '请输入正确的手机号' })
    phone!: string;

    @IsString()
    @Length(1, 30)
    @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value))
    wechatNickname!: string;

    @IsOptional()
    @Matches(/^\d{6}$/, { message: '请输入6位短信验证码' })
    verificationCode?: string;
}
