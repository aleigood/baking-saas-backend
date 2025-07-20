import { Role, ProductionTaskStatus } from '@prisma/client';

export class ProductionTaskDto {
  id: string;
  recipeName: string;
  time: string;
  creator: string;
  status: ProductionTaskStatus;
}

export class RecipeDto {
  id: string;
  name: string;
  type: string;
  weight: number;
  rating: number;
  publicCount: number;
  ingredients: any[]; // 暂时为 any
}

export class IngredientDto {
  id: string;
  name: string;
  brand: string;
  price: number;
  stock: number;
}

export class MemberDto {
  id: string;
  name: string;
  role: Role;
  joinDate: string;
}

export class RecipeStatDto {
  name: string;
  count: number;
}

export class IngredientStatDto {
  name: string;
  consumed: number;
}
