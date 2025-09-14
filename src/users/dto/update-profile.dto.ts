import { IsString, IsOptional, IsUrl } from 'class-validator';

export class UpdateProfileDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsUrl()
    @IsOptional()
    avatarUrl?: string;
}
