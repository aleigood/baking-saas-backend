import { ApiProperty } from '@nestjs/swagger';
// [修改] 导入 IsBoolean, IsNumber
import { IsEnum, IsNotEmpty, IsOptional, IsString, IsBoolean, IsNumber } from 'class-validator';
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

    // [核心修复] 新增 isFlour 字段
    @ApiProperty({ description: 'Is this ingredient flour?', required: false, example: false })
    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    // [核心修复] 新增 waterContent 字段
    @ApiProperty({ description: 'Water content percentage (0-1)', required: false, example: 0 })
    @IsNumber()
    @IsOptional()
    waterContent?: number;
}
