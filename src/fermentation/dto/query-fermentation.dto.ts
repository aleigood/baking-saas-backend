/**
 * 文件路径: src/fermentation/dto/query-fermentation.dto.ts
 * 文件描述: [新增] 定义查询发酵用量接口的请求参数。
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
    SEMI_DRY = 'SEMI_DRY', // [核心新增] 新增半干酵母
    LEVAIN = 'LEVAIN', // 鲁邦种也作为一种类型
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
    temperatureF: number; // 温度 (华氏度)

    @IsNumber()
    @IsNotEmpty()
    @Type(() => Number)
    time: number; // 时间 (小时)
}
