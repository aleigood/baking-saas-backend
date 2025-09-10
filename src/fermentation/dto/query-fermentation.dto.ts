/**
 * 文件路径: src/fermentation/dto/query-fermentation.dto.ts
 * 文件描述: [修改] 将温度单位从华氏度(F)改为摄氏度(C)。
 */
import { IsEnum, IsNotEmpty, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

// 定义酵母/酵头类型的枚举
export enum FermentationType {
    COMMERCIAL_YEAST = 'COMMERCIAL_YEAST',
    LEVAIN = 'LEVAIN',
}

// 定义酵母品牌/种类的枚举
export enum YeastBrand {
    INSTANT_DRY = 'INSTANT_DRY',
    ACTIVE_DRY = 'ACTIVE_DRY',
    FRESH = 'FRESH',
    SEMI_DRY = 'SEMI_DRY',
    LEVAIN = 'LEVAIN',
}

export class QueryFermentationDto {
    @IsEnum(FermentationType)
    @IsNotEmpty()
    type: FermentationType;

    @IsEnum(YeastBrand)
    @IsNotEmpty()
    brand: YeastBrand;

    @IsNumber()
    @IsNotEmpty()
    @Type(() => Number)
    temperatureC: number; // [核心修改] 将 temperatureF 改为 temperatureC，接收摄氏度

    @IsNumber()
    @IsNotEmpty()
    @Type(() => Number)
    time: number; // 时间 (小时)
}
