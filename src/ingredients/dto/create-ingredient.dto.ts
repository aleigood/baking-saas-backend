import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IngredientType } from '@prisma/client';

export class CreateIngredientDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  // 修复：添加 type 字段以匹配 service 逻辑
  @IsEnum(IngredientType)
  @IsOptional()
  type?: IngredientType;
}
