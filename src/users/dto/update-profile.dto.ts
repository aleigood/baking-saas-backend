import { IsString, IsOptional, Matches } from 'class-validator';

export class UpdateProfileDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsString()
    @IsOptional()
    @Matches(/^avatar-(0[1-9]|[1-5]\d|6[0-4])$/, { message: '请选择有效头像' })
    avatarId?: string;
}
