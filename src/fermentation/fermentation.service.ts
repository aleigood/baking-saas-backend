/**
 * 文件路径: src/fermentation/fermentation.service.ts
 * 文件描述: [新增] 提供发酵模型数据的查询和计算服务。
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { FERMENTATION_DATA, LEVAIN_DATA } from '../common/data/fermentation-models';
import { FermentationType, YeastBrand } from './dto/query-fermentation.dto';

// 定义不同酵母相对于即发干酵母(基准, ratio=1)的换算比例
const YEAST_RATIOS = {
    [YeastBrand.INSTANT_DRY]: 1,
    [YeastBrand.ACTIVE_DRY]: 1.25,
    [YeastBrand.FRESH]: 3,
    [YeastBrand.SEMI_DRY]: 2, // [核心新增] 半干酵母的换算系数为2
    [YeastBrand.LEVAIN]: 1, // 鲁邦种自身比例为1
};

@Injectable()
export class FermentationService {
    /**
     * 获取指定模型的可用温度列表 (华氏度)
     * @param type - 发酵模型类型
     * @returns 温度数组
     */
    getAvailableTemperatures(type: FermentationType): number[] {
        const data = type === FermentationType.LEVAIN ? LEVAIN_DATA : FERMENTATION_DATA;
        return Object.keys(data)
            .map(parseFloat)
            .sort((a, b) => a - b);
    }

    /**
     * 根据指定模型的特定温度，获取可用的发酵时间列表
     * @param type - 发酵模型类型
     * @param temperatureF - 华氏温度
     * @returns 时间数组
     */
    getAvailableTimes(type: FermentationType, temperatureF: number): number[] {
        const data = type === FermentationType.LEVAIN ? LEVAIN_DATA : FERMENTATION_DATA;
        const tempKey = this._findClosestKey(data, temperatureF);

        if (!data[tempKey]) {
            return [];
        }

        return Object.keys(data[tempKey])
            .map(parseFloat)
            .sort((a, b) => a - b);
    }

    /**
     * 根据输入参数查找对应的用量百分比
     * @param type - 发酵模型类型
     * @param brand - 酵母/酵头品牌
     * @param temperatureF - 华氏温度
     * @param time - 发酵时间 (小时)
     * @returns 用量百分比数组
     */
    findAmount(type: FermentationType, brand: YeastBrand, temperatureF: number, time: number): number[] {
        const data = type === FermentationType.LEVAIN ? LEVAIN_DATA : FERMENTATION_DATA;
        const tempKey = this._findClosestKey(data, temperatureF);
        const timeData = data[tempKey];

        if (!timeData) {
            throw new NotFoundException(`在模型 ${type} 中找不到温度 ${temperatureF}°F 的相关数据。`);
        }

        const timeKey = this._findClosestKey(timeData, time);
        const baseAmounts = timeData[timeKey];

        if (!baseAmounts) {
            throw new NotFoundException(`在模型 ${type} 的 ${temperatureF}°F 下找不到时间 ${time} 小时的相关数据。`);
        }

        const ratio = YEAST_RATIOS[brand] || 1;

        return baseAmounts.map((amount) => amount * ratio);
    }

    /**
     * 辅助函数：在对象的键中查找最接近给定数值的键
     * @param data - 数据对象
     * @param target - 目标数值
     * @returns 最接近的键
     */
    private _findClosestKey(data: Record<number, any>, target: number): number {
        const keys = Object.keys(data).map(parseFloat);
        return keys.reduce((prev, curr) => (Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev));
    }
}
