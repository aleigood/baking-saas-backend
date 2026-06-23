import { IsString, MaxLength } from 'class-validator';

export class UpdateRecipeVersionNotesDto {
    @IsString()
    @MaxLength(100)
    notes!: string;
}
