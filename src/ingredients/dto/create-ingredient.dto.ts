/**
 * 文件路径: src/ingredients/dto/create-ingredient.dto.ts
 * 文件描述: 定义了创建新原料品类所需的数据结构。
 */
export class CreateIngredientDto {
  name: string;
  hydration?: number; // 含水率，可选
}
