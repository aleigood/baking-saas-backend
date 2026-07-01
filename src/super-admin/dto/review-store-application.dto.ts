import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewStoreApplicationDto {
    @IsOptional()
    @IsString()
    @MaxLength(200)
    reviewNote?: string;
}
