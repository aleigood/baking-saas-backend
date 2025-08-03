import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsNumber,
  IsDateString,
} from 'class-validator';

/**
 * 创建生产任务的数据传输对象
 */
export class CreateProductionTaskDto {
  @IsUUID()
  @IsNotEmpty()
  recipeVersionId: string; // 关联到要生产的配方版本ID

  @IsUUID()
  @IsOptional()
  productId?: string; // 可选，如果任务是生产某个具体产品，则提供产品ID

  @IsNumber()
  @IsNotEmpty()
  quantity: number; // 计划数量

  @IsString()
  @IsNotEmpty()
  unit: string; // 单位 (例如: "件", "克")

  @IsDateString()
  @IsNotEmpty()
  plannedDate: string; // 计划生产日期

  @IsString()
  @IsOptional()
  notes?: string; // 备注
}
