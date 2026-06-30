import { Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { BatchImportRecipeDto } from '../../recipes/dto/batch-import-recipe.dto';

export class ApproveRecipeEditorSessionDto {
    @IsString()
    @IsNotEmpty()
    token!: string;
}

export class ApproveRecipeEditorCodeDto {
    @IsString()
    @IsNotEmpty()
    code!: string;
}

export class RecipeDraftPayloadDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => BatchImportRecipeDto)
    recipes!: BatchImportRecipeDto[];

    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => RecipeDraftTargetDto)
    @IsOptional()
    targets?: RecipeDraftTargetDto[];

    @IsObject()
    @IsOptional()
    meta?: Record<string, unknown>;
}

export class RecipeDraftTargetDto {
    @IsString()
    @IsNotEmpty()
    recipeName!: string;

    @IsUUID()
    @IsOptional()
    familyId?: string;

    @IsUUID()
    @IsOptional()
    baseVersionId?: string;
}

export class UpsertRecipeDraftDto {
    @IsString()
    @IsNotEmpty()
    title!: string;

    @ValidateNested()
    @Type(() => RecipeDraftPayloadDto)
    payload!: RecipeDraftPayloadDto;
}
