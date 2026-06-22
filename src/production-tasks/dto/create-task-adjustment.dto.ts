import { Type } from 'class-transformer';
import {
    ArrayMinSize,
    IsArray,
    IsNumber,
    IsString,
    IsUUID,
    MaxLength,
    Min,
    MinLength,
    ValidateNested,
} from 'class-validator';

export class TaskIngredientAdjustmentDto {
    @IsUUID()
    familyId!: string;

    @IsUUID()
    ingredientId!: string;

    @IsNumber()
    @Min(0.01)
    afterWeightInGrams!: number;
}

export class CreateTaskAdjustmentDto {
    @IsString()
    @MinLength(2, { message: '请填写至少2个字符的调整原因' })
    @MaxLength(200)
    reason!: string;

    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => TaskIngredientAdjustmentDto)
    changes!: TaskIngredientAdjustmentDto[];
}
