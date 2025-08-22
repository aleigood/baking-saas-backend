import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IngredientType } from '@prisma/client';

export class CreateIngredientDto {
    @ApiProperty({ description: 'The name of the ingredient', example: 'High-gluten Flour' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({
        description: 'The type of the ingredient',
        enum: IngredientType,
        example: IngredientType.STANDARD,
        required: false,
    })
    @IsEnum(IngredientType)
    @IsOptional()
    type?: IngredientType;
}
