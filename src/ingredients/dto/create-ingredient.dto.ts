/**
 * 文件路径: src/ingredients/dto/create-ingredient.dto.ts
 * 文件描述: (已重构) 添加了完整的 class-validator 验证装饰器。
 */
import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class CreateIngredientDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @IsOptional()
  hydration?: number;
}
