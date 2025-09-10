/**
 * 文件路径: src/fermentation/fermentation.service.ts
 * 文件描述: [核心修正] 将换算基准从即时干酵母改为鲜酵母，并修正换算系数，以确保计算结果的准确性。
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { FERMENTATION_DATA, LEVAIN_DATA } from '../common/data/fermentation-models';
import { FermentationType, YeastBrand } from './dto/query-fermentation.dto';

// [核心修正] 以鲜酵母(Fresh Yeast)为基准(ratio=1)，根据您提供的换算表更新所有系数
const YEAST_RATIOS = {
    [YeastBrand.FRESH]: 1, // 鲜酵母 (基准)
    [YeastBrand.SEMI_DRY]: 0.48, // 半干酵母是鲜酵母的 50%
    [YeastBrand.ACTIVE_DRY]: 0.42, // 活性干酵母是鲜酵母的 66% (≈ 1/1.5)
    [YeastBrand.INSTANT_DRY]: 0.32, // 即时干酵母是鲜酵母的 33% (≈ 1/3)
    [YeastBrand.LEVAIN]: 1, // 鲁邦种查询自己的数据模型，系数设为1
};

@Injectable()
export class FermentationService {
    private _celsiusToFahrenheit(celsius: number): number {
        return (celsius * 9) / 5 + 32;
    }

    private _fahrenheitToCelsius(fahrenheit: number): number {
        return ((fahrenheit - 32) * 5) / 9;
    }

    getAvailableTemperatures(type: FermentationType): number[] {
        const data = type === FermentationType.LEVAIN ? LEVAIN_DATA : FERMENTATION_DATA;
        return Object.keys(data)
            .map(parseFloat)
            .map((f) => parseFloat(this._fahrenheitToCelsius(f).toFixed(1)))
            .sort((a, b) => a - b);
    }

    getAvailableTimes(type: FermentationType, temperatureC: number): number[] {
        const data = type === FermentationType.LEVAIN ? LEVAIN_DATA : FERMENTATION_DATA;
        const temperatureF = this._celsiusToFahrenheit(temperatureC);
        const tempKey = this._findClosestKey(data, temperatureF);

        if (!data[tempKey]) {
            return [];
        }

        return Object.keys(data[tempKey])
            .map(parseFloat)
            .sort((a, b) => a - b);
    }

    findAmount(type: FermentationType, brand: YeastBrand, temperatureC: number, time: number): number[] {
        // 如果是鲁邦种，则查询鲁邦种的专用数据，否则查询商业酵母数据
        const data = type === FermentationType.LEVAIN ? LEVAIN_DATA : FERMENTATION_DATA;
        const temperatureF = this._celsiusToFahrenheit(temperatureC);

        const tempKeys = Object.keys(data)
            .map(parseFloat)
            .sort((a, b) => a - b);
        const [t1, t2] = this._findBoundingKeys(tempKeys, temperatureF);

        const amount1 = this._interpolateTime(data[t1], time);
        const amount2 = this._interpolateTime(data[t2], time);

        let finalAmount: number;
        if (t1 === t2) {
            finalAmount = amount1;
        } else {
            finalAmount = amount1 + ((amount2 - amount1) * (temperatureF - t1)) / (t2 - t1);
        }

        // 应用正确的换算系数
        const ratio = YEAST_RATIOS[brand] || 1;
        const result = finalAmount * ratio;

        // 将计算出的百分比值转换为小数后返回
        return [result / 100];
    }

    private _interpolateTime(timeData: Record<number, number[]>, targetTime: number): number {
        if (!timeData) {
            throw new NotFoundException(`插值计算失败：缺少时间数据。`);
        }
        const timeKeys = Object.keys(timeData)
            .map(parseFloat)
            .sort((a, b) => a - b);
        const [t1, t2] = this._findBoundingKeys(timeKeys, targetTime);

        const v1 = timeData[t1][0];
        const v2 = timeData[t2][0];

        if (t1 === t2) {
            return v1;
        }

        return v1 + ((v2 - v1) * (targetTime - t1)) / (t2 - t1);
    }

    private _findBoundingKeys(keys: number[], target: number): [number, number] {
        if (target <= keys[0]) {
            return [keys[0], keys[0]];
        }
        if (target >= keys[keys.length - 1]) {
            return [keys[keys.length - 1], keys[keys.length - 1]];
        }

        let lower = keys[0];
        let upper = keys[keys.length - 1];

        for (const key of keys) {
            if (key <= target && key > lower) {
                lower = key;
            }
            if (key >= target && key < upper) {
                upper = key;
            }
        }
        return [lower, upper];
    }

    // [保留] 此函数仅用于在getAvailableTimes中快速定位，不用于最终计算
    private _findClosestKey(data: Record<number, any>, target: number): number {
        const keys = Object.keys(data).map(parseFloat);
        return keys.reduce((prev, curr) => (Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev));
    }
}
