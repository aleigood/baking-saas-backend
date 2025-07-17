/**
 * 文件路径: src/recipes/dto/create-recipe.dto.ts
 * 文件描述: 定义了创建配方家族所需的数据结构。
 */
// 注意：为了简化，我们暂时不使用class-validator进行详细验证

class CreateDoughIngredientDto {
  name: string;
  ratio: number;
  isFlour: boolean;
}

class CreateDoughDto {
  name: string;
  isPreDough: boolean;
  targetTemp?: number;
  ingredients: CreateDoughIngredientDto[];
}

class CreateProductMixInDto {
  name: string;
  ratio: number;
}

class CreateProductAddOnDto {
  name: string; // 这里是Extra的名称，如“柠檬奶油奶酪”
  weight: number;
  type: 'FILLING' | 'TOPPING';
}

class CreateProductDto {
  name: string;
  weight: number;
  mixIns: CreateProductMixInDto[];
  addOns: CreateProductAddOnDto[];
  procedures: CreateProcedureDto[];
}

class CreateProcedureDto {
  step: number;
  name: string;
  description: string;
}

export class CreateRecipeFamilyDto {
  name: string;
  keyPoints?: string[]; // 兼容旧版，但我们现在使用procedures
  doughs: CreateDoughDto[];
  products: CreateProductDto[];
  procedures: CreateProcedureDto[]; // 通用工序
}
