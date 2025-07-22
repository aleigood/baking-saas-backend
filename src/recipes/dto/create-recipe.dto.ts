/**
 * 文件路径: src/recipes/dto/create-recipe.dto.ts
 * 文件描述: (已重构) 为复杂的嵌套结构添加了完整的递归验证。
 */
import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsEnum,
  ValidateNested,
  IsArray,
  ArrayMinSize,
  IsPositive,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AddOnType } from '@prisma/client';

// 注意：为了让 @ValidateNested 生效，所有嵌套的 DTO 也必须是 class 并有验证装饰器。

class CreateDoughIngredientDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  ratio: number;

  @IsBoolean()
  isFlour: boolean;
}

class CreateDoughDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsBoolean()
  isPreDough: boolean;

  @IsNumber()
  @IsOptional()
  targetTemp?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateDoughIngredientDto)
  ingredients: CreateDoughIngredientDto[];
}

class CreateProductMixInDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  ratio: number;
}

class CreateProductAddOnDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsPositive()
  weight: number;

  @IsEnum(AddOnType)
  type: AddOnType;
}

class CreateProcedureDto {
  @IsNumber()
  step: number;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  description: string;
}

class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsPositive()
  weight: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductMixInDto)
  @IsOptional()
  mixIns: CreateProductMixInDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProductAddOnDto)
  @IsOptional()
  addOns: CreateProductAddOnDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProcedureDto)
  @IsOptional()
  procedures: CreateProcedureDto[];
}

export class CreateRecipeFamilyDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateDoughDto)
  doughs: CreateDoughDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateProductDto)
  products: CreateProductDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateProcedureDto)
  @IsOptional()
  procedures: CreateProcedureDto[];
}
