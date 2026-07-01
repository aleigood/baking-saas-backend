import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewMembershipApplicationDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    reviewNote?: string;
}
