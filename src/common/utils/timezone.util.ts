/**
 * 文件路径: src/common/utils/timezone.util.ts
 * 文件描述: [新增] 提供时区无关的起止时间点计算辅助函数，默认以北京时间 (UTC+8) 为基准。
 */

/**
 * 根据传入的日期和时区偏移量，计算出该日期在 UTC 下的起止 Date 对象（00:00:00.000 至 23:59:59.999）。
 * 默认 offsetHours 为 8 (北京时间)。
 */
export function getUtcDayBounds(dateOrStr?: string | Date, offsetHours = 8): { start: Date; end: Date } {
    let year: number;
    let month: number;
    let day: number;

    if (!dateOrStr) {
        // 当前时刻在指定时区下的日期组件
        const now = new Date();
        const localNow = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);
        year = localNow.getUTCFullYear();
        month = localNow.getUTCMonth();
        day = localNow.getUTCDate();
    } else if (typeof dateOrStr === 'string') {
        const match = dateOrStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (match) {
            year = parseInt(match[1], 10);
            month = parseInt(match[2], 10) - 1;
            day = parseInt(match[3], 10);
        } else {
            const targetDate = new Date(dateOrStr);
            if (isNaN(targetDate.getTime())) {
                return getUtcDayBounds(undefined, offsetHours);
            }
            const localDate = new Date(targetDate.getTime() + offsetHours * 60 * 60 * 1000);
            year = localDate.getUTCFullYear();
            month = localDate.getUTCMonth();
            day = localDate.getUTCDate();
        }
    } else {
        const targetDate = dateOrStr;
        const localDate = new Date(targetDate.getTime() + offsetHours * 60 * 60 * 1000);
        year = localDate.getUTCFullYear();
        month = localDate.getUTCMonth();
        day = localDate.getUTCDate();
    }

    // 根据时区偏移，计算对应的 UTC 零点和午夜时刻
    const start = new Date(Date.UTC(year, month, day, 0 - offsetHours, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, day, 23 - offsetHours, 59, 59, 999));
    return { start, end };
}
