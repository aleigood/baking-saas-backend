import { IsBoolean, IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { IngredientType } from '@prisma/client';

// 修复：移除对 @nestjs/mapped-types 的依赖，并手动定义可选字段
// 这解决了 "Cannot find module" 的错误
export class UpdateIngredientDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsEnum(IngredientType)
    @IsOptional()
    type?: IngredientType;

    // [核心新增] 增加 isFlour 和 waterContent 字段
    @IsBoolean()
    @IsOptional()
    isFlour?: boolean;

    @IsNumber()
    @IsOptional()
    waterContent?: number;
}
