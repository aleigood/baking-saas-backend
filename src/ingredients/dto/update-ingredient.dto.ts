/**
 * 文件路径: src/ingredients/dto/update-ingredient.dto.ts
 * 文件描述: 定义了更新原料信息（如含水率）所需的数据结构。
 */
import { IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateIngredientDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  hydration?: number;
}
