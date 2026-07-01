import { IsString, IsOptional, Matches, Length } from 'class-validator';

export class UpdateProfileDto {
    @IsString()
    @IsOptional()
    @Length(1, 30)
    wechatNickname?: string;

    @IsString()
    @IsOptional()
    @Matches(/^avatar-(0[1-9]|[1-5]\d|6[0-4])$/, { message: '请选择有效头像' })
    avatarId?: string;
}
