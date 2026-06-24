import { IsArray, IsUUID } from 'class-validator';

export class SelectFreeRecipesDto {
    @IsArray()
    @IsUUID('4', { each: true })
    recipeIds!: string[];
}
