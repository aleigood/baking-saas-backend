import { PrismaClient, Role, RecipeType, ProductIngredientType } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

// 定义配方数据的类型，以便在代码中使用
// [核心修改] 增加 flourRatio 字段以支持新的配方意图
type RecipeSeedIngredient = {
    name: string;
    ratio?: number; // 对于预制面团，此字段将由后端计算，因此在种子数据中为可选
    flourRatio?: number; // 用于预制面团的意图字段
    isFlour?: boolean;
    waterContent?: number;
};

type RecipeSeedData = {
    name: string;
    type: RecipeType;
    targetTemp?: number;
    lossRatio?: number;
    ingredients: RecipeSeedIngredient[];
    products?: {
        name: string;
        weight: number;
        fillings?: { name: string; type: ProductIngredientType; weightInGrams: number }[];
        mixIn?: { name: string; type: ProductIngredientType; ratio: number }[];
        procedure?: string[];
    }[];
    procedure?: string[];
};

// [核心修改] 更新了所有主配方，使用 flourRatio 表达预制面团的用量意图
const recipesData: RecipeSeedData[] = [
    {
        name: 'BIGA',
        type: 'PRE_DOUGH',
        ingredients: [
            {
                name: '高筋粉',
                ratio: 1.0,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.5,
                waterContent: 1.0,
            },
        ],
        procedure: [],
    },
    {
        name: '烫种',
        type: 'PRE_DOUGH',
        ingredients: [
            {
                name: '高筋粉',
                ratio: 1.0,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 2.0,
                waterContent: 1.0,
            },
            {
                name: '糖',
                ratio: 0.2,
            },
            {
                name: '盐',
                ratio: 0.02,
            },
        ],
        procedure: [],
    },
    {
        name: '柠檬奶油奶酪',
        type: 'EXTRA',
        ingredients: [
            {
                name: '奶油奶酪',
                ratio: 1.0,
            },
            {
                name: '糖',
                ratio: 0.07,
            },
            {
                name: '柠檬汁',
                ratio: 0.025,
            },
            {
                name: '柠檬皮',
                ratio: 0.01,
            },
        ],
        procedure: [],
    },
    {
        name: '酒渍芒果干',
        type: 'EXTRA',
        ingredients: [
            {
                name: '芒果干',
                ratio: 1.0,
            },
            {
                name: '荔枝酒',
                ratio: 0.25,
            },
        ],
        procedure: [],
    },
    {
        name: '酒渍蔓越莓干',
        type: 'EXTRA',
        ingredients: [
            {
                name: '蔓越莓干',
                ratio: 1.0,
            },
            {
                name: '荔枝酒',
                ratio: 0.25,
            },
        ],
        procedure: [],
    },
    {
        name: '酒渍提子干',
        type: 'EXTRA',
        ingredients: [
            {
                name: '提子干',
                ratio: 1.0,
            },
            {
                name: '朗姆酒',
                ratio: 0.25,
            },
        ],
        procedure: [],
    },
    {
        name: '贝果',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            {
                name: 'BIGA',
                flourRatio: 0.2, // 意图：使用主面团20%的面粉制作BIGA
            },
            {
                name: '烫种',
                flourRatio: 0.08, // 意图：使用主面团8%的面粉制作烫种
            },
            {
                name: '高筋粉',
                ratio: 0.72, // 1 - 0.2 - 0.08 = 0.72
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.38,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.0134,
            },
            {
                name: '糖',
                ratio: 0.044,
            },
            {
                name: '半干酵母',
                ratio: 0.005,
            },
            {
                name: '黄油',
                ratio: 0.04,
            },
        ],
        products: [
            {
                name: '原味贝果',
                weight: 80,
                fillings: [],
                mixIn: [],
            },
            {
                name: '伯爵柠檬乳酪贝果',
                weight: 90,
                fillings: [
                    {
                        name: '柠檬奶油奶酪',
                        type: 'FILLING',
                        weightInGrams: 15,
                    },
                ],
                mixIn: [
                    {
                        name: '伯爵红茶',
                        type: 'MIX_IN',
                        ratio: 0.012,
                    },
                ],
            },
            {
                name: '芒果荔枝酒贝果',
                weight: 90,
                fillings: [
                    {
                        name: '酒渍芒果干',
                        type: 'FILLING',
                        weightInGrams: 10,
                    },
                ],
                mixIn: [
                    {
                        name: '酒渍芒果干',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                ],
            },
            {
                name: '蔓越莓贝果',
                weight: 90,
                fillings: [
                    {
                        name: '酒渍蔓越莓干',
                        type: 'FILLING',
                        weightInGrams: 10,
                    },
                ],
                mixIn: [
                    {
                        name: '酒渍蔓越莓干',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                ],
            },
            {
                name: '肉桂提子贝果',
                weight: 90,
                fillings: [
                    {
                        name: '酒渍提子干',
                        type: 'FILLING',
                        weightInGrams: 10,
                    },
                ],
                mixIn: [
                    {
                        name: '肉桂粉',
                        type: 'MIX_IN',
                        ratio: 0.02,
                    },
                    {
                        name: '酒渍提子干',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                ],
            },
        ],
        procedure: [
            '备料：果干要切小丁，洗掉表面的糖，烘干后用酒浸泡一夜，茶粉用冷水泡开，所有配料都要提前称好后再打面',
            '搅拌：材料全部加入，搅拌至7分筋，表面有一点光滑，厚膜有锯齿，需要加入搅拌的果干需要提前晾干，伯爵红茶贝果最后搅拌',
            '发酵：26度，一发30分钟，不需要充分发酵，分割后轻轻滚圆，不要收紧，二发到1.5倍大，不同颜色的面团不要放在一起发酵',
            '整形：卷起前上下边缘打薄，封口要朝内',
            '煮水：蜂蜜10%或糖5%煮至微微沸腾，一面烫30秒，煮完要控水',
            '烘烤：一盘8个 上火230 下火190 烤15分钟 喷3秒蒸汽',
            '出炉：出炉后表面喷水',
        ],
    },
    {
        name: '鲁邦种',
        type: 'PRE_DOUGH',
        ingredients: [
            {
                name: 'T65',
                ratio: 1.0,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 1.0,
                waterContent: 1.0,
            },
        ],
        procedure: [],
    },
    {
        name: '有盐黄油',
        type: 'EXTRA',
        ingredients: [
            {
                name: '发酵黄油',
                ratio: 1.0,
            },
            {
                name: '海盐',
                ratio: 0.017,
            },
        ],
        procedure: [],
    },
    {
        name: '海盐卷',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            {
                name: '鲁邦种',
                flourRatio: 0.2, // 意图：使用主面团20%的面粉制作鲁邦种
            },
            {
                name: 'T65',
                ratio: 0.6,
                isFlour: true,
            },
            {
                name: '高筋粉',
                ratio: 0.2,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.45,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.018,
            },
            {
                name: '糖',
                ratio: 0.04,
            },
            {
                name: '半干酵母',
                ratio: 0.008,
            },
            {
                name: '黄油',
                ratio: 0.04,
            },
            {
                name: '麦芽精',
                ratio: 0.003,
            },
        ],
        products: [
            {
                name: '原味海盐卷',
                weight: 65,
                fillings: [
                    {
                        name: '有盐黄油',
                        type: 'FILLING',
                        weightInGrams: 6,
                    },
                ],
                mixIn: [],
            },
        ],
        procedure: [
            '搅拌：材料全部加入搅拌，搅拌至表面光滑，破洞有微微锯齿',
            '发酵：一发需要充分发酵，分割后轻轻滚圆，不要收紧，中间低温醒发至少30分钟，二发不超过28度且要发酵充分',
            '整型：中下部的两边可刷黄油，卷起时不要拉长',
            '烘烤：一盘12个 上火250 下火220 烤12分钟 喷3秒蒸汽',
        ],
    },
    {
        name: '恰巴塔',
        type: 'MAIN',
        targetTemp: 22,
        ingredients: [
            {
                name: '鲁邦种',
                flourRatio: 0.2, // 意图：使用主面团20%的面粉制作鲁邦种
            },
            {
                name: 'T65',
                ratio: 0.3,
                isFlour: true,
            },
            {
                name: '高筋粉',
                ratio: 0.5,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.6,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.018,
            },
            {
                name: '糖',
                ratio: 0.01,
            },
            {
                name: '半干酵母',
                ratio: 0.005,
            },
            {
                name: '麦芽精',
                ratio: 0.003,
            },
            {
                name: '黄油',
                ratio: 0.05,
            },
        ],
        products: [
            {
                name: '得意奶酪恰巴塔',
                weight: 150,
                fillings: [],
                mixIn: [
                    {
                        name: '图林根香肠',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                    {
                        name: '萨拉米肠',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                    {
                        name: '马苏里拉芝士',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                ],
            },
        ],
        procedure: [
            '搅拌：搅拌至有延展性和弹性，易搅碎的馅料折叠进去',
            '发酵：一发充分发酵，半小时小时翻一次面或翻面后放入冰箱发酵12小时，最终发酵时面团不要放太近，容易粘在一起',
            '烘烤：一盘6个 上火255 下火250 喷3-4秒蒸汽 烤13分钟',
        ],
    },
    {
        name: '佛卡夏',
        type: 'MAIN',
        targetTemp: 22,
        ingredients: [
            {
                name: '鲁邦种',
                flourRatio: 0.2, // 意图：使用主面团20%的面粉制作鲁邦种
            },
            {
                name: 'T65',
                ratio: 0.3,
                isFlour: true,
            },
            {
                name: '高筋粉',
                ratio: 0.5,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.6,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.018,
            },
            {
                name: '糖',
                ratio: 0.01,
            },
            {
                name: '半干酵母',
                ratio: 0.005,
            },
            {
                name: '麦芽精',
                ratio: 0.003,
            },
            {
                name: '黄油',
                ratio: 0.05,
            },
        ],
        products: [
            {
                name: '佛卡夏',
                weight: 80,
                fillings: [],
                mixIn: [],
            },
        ],
        procedure: [
            '搅拌：搅拌至有延展性和弹性，易搅碎的馅料折叠进去',
            '发酵：一发充分发酵，半小时小时翻一次面或翻面后放入冰箱发酵12小时，最终发酵时面团不要放太近，容易粘在一起',
            '烘烤：一盘9个 上火260 下火250 喷3-4秒蒸汽 烤12分钟',
        ],
    },
    {
        name: '酵香吐司',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            {
                name: '鲁邦种',
                flourRatio: 0.15, // 意图：使用主面团15%的面粉制作鲁邦种
            },
            {
                name: 'BIGA',
                flourRatio: 0.3, // 意图：使用主面团30%的面粉制作BIGA
            },
            {
                name: '高筋粉',
                ratio: 0.55, // 1 - 0.15 - 0.3 = 0.55
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.35,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.016,
            },
            {
                name: '糖',
                ratio: 0.06,
            },
            {
                name: '半干酵母',
                ratio: 0.008,
            },
            {
                name: '黄油',
                ratio: 0.06,
            },
        ],
        products: [
            {
                name: '酵香吐司',
                weight: 240,
                fillings: [],
                mixIn: [],
            },
        ],
        procedure: [
            '搅拌：黄油在出膜时加入，搅拌至完全扩展，薄膜无锯齿',
            '发酵：一发充分发酵，二发至8分满',
            '整型：两次擀卷',
            '烘烤：一盘6个 上火170 下火245 烤20分钟',
        ],
    },
    {
        name: '云朵吐司',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            {
                name: 'BIGA',
                flourRatio: 0.2, // 意图：使用主面团20%的面粉制作BIGA
            },
            {
                name: '烫种',
                flourRatio: 0.08, // 意图：使用主面团8%的面粉制作烫种
            },
            {
                name: '高筋粉',
                ratio: 0.72, // 1 - 0.2 - 0.08 = 0.72
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.54,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.0164,
            },
            {
                name: '糖',
                ratio: 0.044,
            },
            {
                name: '半干酵母',
                ratio: 0.008,
            },
            {
                name: '奶粉',
                ratio: 0.02,
            },
            {
                name: '黄油',
                ratio: 0.08,
            },
            {
                name: '麦芽精',
                ratio: 0.003,
            },
        ],
        products: [
            {
                name: '云朵吐司',
                weight: 245,
                fillings: [],
                mixIn: [],
            },
            {
                name: '玫瑰云朵吐司',
                weight: 245,
                fillings: [],
                mixIn: [
                    {
                        name: '玫瑰花酱',
                        type: 'MIX_IN',
                        ratio: 0.08,
                    },
                    {
                        name: '玫瑰花瓣',
                        type: 'MIX_IN',
                        ratio: 0.003,
                    },
                ],
            },
            {
                name: '桂花云朵吐司',
                weight: 245,
                fillings: [],
                mixIn: [
                    {
                        name: '桂花酱',
                        type: 'MIX_IN',
                        ratio: 0.08,
                    },
                    {
                        name: '桂花瓣',
                        type: 'MIX_IN',
                        ratio: 0.003,
                    },
                ],
            },
            {
                name: '茉莉云朵吐司',
                weight: 245,
                fillings: [],
                mixIn: [
                    {
                        name: '茉莉花酱',
                        type: 'MIX_IN',
                        ratio: 0.08,
                    },
                    {
                        name: '茉莉花瓣',
                        type: 'MIX_IN',
                        ratio: 0.003,
                    },
                ],
            },
        ],
        procedure: [
            '搅拌：黄油在出膜时加入，搅拌至完全扩展，薄膜无锯齿',
            '发酵：一发充分发酵，二发至9分满',
            '整型：两次擀卷',
            '烘烤：一盘6个吐司盒放薄烤盘上 上火170 下火245 烤20分钟',
        ],
    },
    {
        name: '咸蛋黄酱',
        type: 'EXTRA',
        ingredients: [
            {
                name: '咸蛋黄',
                ratio: 1.0,
            },
            {
                name: '黄油',
                ratio: 0.15,
            },
        ],
        procedure: [],
    },
    {
        name: 'BR面团',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            {
                name: '烫种',
                flourRatio: 0.08, // 意图：使用主面团8%的面粉制作烫种
            },
            {
                name: '高筋粉',
                ratio: 0.92, // 1 - 0.08 = 0.92
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.34,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.0164,
            },
            {
                name: '糖',
                ratio: 0.084,
            },
            {
                name: '半干酵母',
                ratio: 0.008,
            },
            {
                name: '奶粉',
                ratio: 0.03,
            },
            {
                name: '黄油',
                ratio: 0.1,
            },
            {
                name: '牛奶',
                ratio: 0.1,
                waterContent: 0.87,
            },
            {
                name: '全蛋',
                ratio: 0.15,
                waterContent: 0.75,
            },
            {
                name: '麦芽精',
                ratio: 0.003,
            },
        ],
        products: [
            {
                name: '香葱肉松吐司',
                weight: 240,
                fillings: [
                    {
                        name: '肉松',
                        type: 'FILLING',
                        weightInGrams: 20,
                    },
                    {
                        name: '沙拉酱',
                        type: 'FILLING',
                        weightInGrams: 10,
                    },
                    {
                        name: '香葱',
                        type: 'FILLING',
                        weightInGrams: 10,
                    },
                ],
                mixIn: [],
            },
            {
                name: '蛋黄肉松吐司',
                weight: 240,
                fillings: [
                    {
                        name: '肉松',
                        type: 'FILLING',
                        weightInGrams: 20,
                    },
                    {
                        name: '咸蛋黄酱',
                        type: 'FILLING',
                        weightInGrams: 20,
                    },
                ],
                mixIn: [],
            },
        ],
        procedure: [
            '搅拌：黄油在出膜时加入，糖分两次加入，搅拌至完全扩展，薄膜无锯齿',
            '发酵：一发充分发酵，二发至9分满',
            '整型：编辫后要压平再卷起，防止出现空洞',
            '烘烤：一盘6个 上火165 下火235 烤21分钟',
        ],
    },
    {
        name: '卡仕达酱',
        type: 'EXTRA',
        ingredients: [
            {
                name: '牛奶',
                ratio: 1.0,
            },
            {
                name: '蛋黄',
                ratio: 0.2,
            },
            {
                name: '糖',
                ratio: 0.2,
            },
            {
                name: '低筋粉',
                ratio: 0.12,
            },
            {
                name: '黄油',
                ratio: 0.05,
            },
        ],
        procedure: [],
    },
    {
        name: '甜面团',
        type: 'MAIN',
        targetTemp: 26,
        ingredients: [
            {
                name: '烫种',
                flourRatio: 0.08, // 意图：使用主面团8%的面粉制作烫种
            },
            {
                name: '高筋粉',
                ratio: 0.92, // 1 - 0.08 = 0.92
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.4,
                waterContent: 1.0,
            },
            {
                name: '盐',
                ratio: 0.0084,
            },
            {
                name: '糖',
                ratio: 0.184,
            },
            {
                name: '半干酵母',
                ratio: 0.013,
            },
            {
                name: '黄油',
                ratio: 0.08,
            },
            {
                name: '奶粉',
                ratio: 0.02,
            },
            {
                name: '全蛋',
                ratio: 0.2,
                waterContent: 0.75,
            },
            {
                name: '麦芽精',
                ratio: 0.01,
            },
        ],
        products: [
            {
                name: '熊掌卡仕达',
                weight: 50,
                fillings: [
                    {
                        name: '卡仕达酱',
                        type: 'FILLING',
                        weightInGrams: 30,
                    },
                ],
                mixIn: [],
            },
        ],
        procedure: [
            '搅拌：采用后糖法，搅拌至完全扩展',
            '发酵：二发温度35度50分钟',
            '烘烤：烤前刷过筛蛋液，两个杏仁片 一盘10个 上火210 下火180 烤10分钟',
        ],
    },
    {
        name: '黑麦鲁邦种',
        type: 'PRE_DOUGH',
        ingredients: [
            {
                name: 'T170',
                ratio: 1.0,
                isFlour: true,
            },
            {
                name: '水',
                ratio: 1.5,
                waterContent: 1.0,
            },
        ],
        procedure: [],
    },
    {
        name: '黑麦欧包',
        type: 'MAIN',
        targetTemp: 22,
        ingredients: [
            {
                name: '黑麦鲁邦种',
                flourRatio: 0.2, // 意图：使用主面团20%的面粉制作黑麦鲁邦种
            },
            {
                name: '高筋粉',
                ratio: 0.8, // 1 - 0.2 = 0.8
                isFlour: true,
            },
            {
                name: '水',
                ratio: 0.54,
                waterContent: 1.0,
            },
            {
                name: '半干酵母',
                ratio: 0.005,
            },
            {
                name: '盐',
                ratio: 0.018,
            },
            {
                name: '麦芽精',
                ratio: 0.01,
            },
        ],
        products: [
            {
                name: '提子核桃黑麦欧包',
                weight: 250,
                fillings: [],
                mixIn: [
                    {
                        name: '核桃干',
                        type: 'MIX_IN',
                        ratio: 0.15,
                    },
                    {
                        name: '酒渍提子干',
                        type: 'MIX_IN',
                        ratio: 0.2,
                    },
                ],
            },
        ],
        procedure: [
            '搅拌：黑麦酵头在面筋初步形成后加入，不要打到完全扩展状态',
            '发酵：20分钟折叠一次',
            '烘烤：一盘6个 上火250 下火230 烤20分钟 喷3秒蒸汽',
        ],
    },
];

/**
 * 为指定的店铺导入所有配方数据
 * @param tenantId 店铺ID
 * @param recipes 配方数据数组
 */
async function seedRecipesForTenant(tenantId: string, recipes: RecipeSeedData[]) {
    console.log(`为店铺 ID: ${tenantId} 开始导入配方...`);

    // [核心修复] 创建一个 Set 来存储所有已经被定义为配方的名称
    const recipeNames = new Set(recipes.map((r) => r.name));

    // [核心修改] 创建一个Map来存储原料的完整信息，而不仅仅是名字
    const allIngredients = new Map<string, RecipeSeedIngredient>();
    recipes.forEach((recipe) => {
        recipe.ingredients.forEach((ing) => {
            // 只有当原料信息更完整时才更新Map
            const existing = allIngredients.get(ing.name);
            if (!existing || (!existing.isFlour && ing.isFlour)) {
                allIngredients.set(ing.name, ing);
            }
        });
        recipe.products?.forEach((p) => {
            p.fillings?.forEach((f) => {
                if (!allIngredients.has(f.name)) allIngredients.set(f.name, { name: f.name, ratio: 0 });
            });
            p.mixIn?.forEach((m) => {
                if (!allIngredients.has(m.name)) allIngredients.set(m.name, { name: m.name, ratio: 0 });
            });
        });
    });

    for (const [name, details] of allIngredients.entries()) {
        // [核心修复] 在创建原料前，检查这个名字是否已经被用作配方名称
        if (recipeNames.has(name)) {
            console.log(`  - 跳过创建原料: "${name}"，因为它已经是一个配方。`);
            continue; // 如果是配方，则跳过，不创建同名的普通原料
        }

        const existingIngredient = await prisma.ingredient.findFirst({
            where: {
                tenantId,
                name,
                deletedAt: null,
            },
        });

        if (!existingIngredient) {
            // [核心修改] 创建原料时，传入isFlour和waterContent
            await prisma.ingredient.create({
                data: {
                    tenantId,
                    name,
                    isFlour: details.isFlour ?? false,
                    waterContent: details.waterContent ?? 0,
                },
            });
        }
    }
    console.log(`为店铺 ID: ${tenantId} 创建了 ${allIngredients.size} 种基础原料。`);

    // 导入配方
    for (const recipeData of recipes) {
        await prisma.$transaction(async (tx) => {
            // 1. 创建配方族
            const recipeFamily = await tx.recipeFamily.create({
                data: {
                    name: recipeData.name,
                    tenantId: tenantId,
                    type: recipeData.type,
                },
            });

            // 2. 创建配方版本
            const recipeVersion = await tx.recipeVersion.create({
                data: {
                    familyId: recipeFamily.id,
                    version: 1,
                    notes: '初始版本',
                    isActive: true,
                },
            });

            // 3. 创建面团和面团原料
            if (recipeData.ingredients) {
                const dough = await tx.dough.create({
                    data: {
                        recipeVersionId: recipeVersion.id,
                        name: recipeData.name,
                        targetTemp: recipeData.targetTemp,
                        lossRatio: recipeData.lossRatio,
                        procedure: recipeData.procedure,
                    },
                });

                for (const ing of recipeData.ingredients) {
                    const linkedIngredient = await tx.ingredient.findFirst({
                        where: { tenantId, name: ing.name, deletedAt: null },
                    });
                    const linkedPreDough = await tx.recipeFamily.findFirst({
                        where: { tenantId, name: ing.name, type: 'PRE_DOUGH', deletedAt: null },
                    });

                    // [核心修改] 新增逻辑，如果提供了 flourRatio，则动态计算 ratio
                    let finalRatio = ing.ratio;
                    if (ing.flourRatio && linkedPreDough) {
                        const preDoughActiveVersion = await tx.recipeVersion.findFirst({
                            where: { familyId: linkedPreDough.id, isActive: true },
                            include: { doughs: { include: { ingredients: true } } },
                        });
                        const preDoughRecipe = preDoughActiveVersion?.doughs[0];
                        if (preDoughRecipe) {
                            const preDoughTotalRatioSum = preDoughRecipe.ingredients.reduce(
                                (sum, i) => sum + (i.ratio ?? 0),
                                0,
                            );
                            finalRatio = ing.flourRatio * preDoughTotalRatioSum;
                        }
                    }

                    await tx.doughIngredient.create({
                        data: {
                            doughId: dough.id,
                            ratio: finalRatio,
                            flourRatio: ing.flourRatio,
                            ingredientId: linkedIngredient ? linkedIngredient.id : null,
                            linkedPreDoughId: linkedPreDough ? linkedPreDough.id : null,
                        },
                    });
                }
            }

            // 4. 创建产品和产品原料
            if (recipeData.products) {
                for (const p of recipeData.products) {
                    const product = await tx.product.create({
                        data: {
                            recipeVersionId: recipeVersion.id,
                            name: p.name,
                            baseDoughWeight: p.weight,
                            procedure: p.procedure,
                        },
                    });

                    const productIngredients = [...(p.fillings || []), ...(p.mixIn || [])];

                    for (const pi of productIngredients) {
                        const linkedIngredient = await tx.ingredient.findFirst({
                            where: { tenantId, name: pi.name, deletedAt: null },
                        });
                        const linkedExtra = await tx.recipeFamily.findFirst({
                            where: { tenantId, name: pi.name, type: 'EXTRA', deletedAt: null },
                        });

                        await tx.productIngredient.create({
                            data: {
                                productId: product.id,
                                type: pi.type,
                                ratio: 'ratio' in pi ? pi.ratio : undefined,
                                weightInGrams: 'weightInGrams' in pi ? pi.weightInGrams : undefined,
                                ingredientId: linkedIngredient ? linkedIngredient.id : null,
                                linkedExtraId: linkedExtra ? linkedExtra.id : null,
                            },
                        });
                    }
                }
            }
        });
        console.log(`  - 成功导入配方: ${recipeData.name}`);
    }
}

async function main() {
    console.log('开始执行种子脚本...');

    // 1. 创建超级管理员
    const adminPhone = process.env.SUPER_ADMIN_PHONE || '13955555555';
    const adminPassword = process.env.SUPER_ADMIN_PASSWORD || 'admin';
    const hashedAdminPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.upsert({
        where: { phone: adminPhone },
        update: {},
        create: {
            name: '超级管理员',
            phone: adminPhone,
            password: hashedAdminPassword,
            role: Role.SUPER_ADMIN,
            status: 'ACTIVE',
        },
    });
    console.log(`超级管理员已创建/确认存在: ${adminPhone}`);

    // 2. 创建普通用户 Leo
    const leoPhone = '13966666666';
    const leoPassword = '123';
    const hashedLeoPassword = await bcrypt.hash(leoPassword, 10);

    const leo = await prisma.user.upsert({
        where: { phone: leoPhone },
        update: {},
        create: {
            name: 'Leo',
            phone: leoPhone,
            password: hashedLeoPassword,
            role: Role.OWNER,
            status: 'ACTIVE',
        },
    });
    console.log(`用户 "Leo" 已创建/确认存在: ${leoPhone}`);

    // 3. 为 Leo 创建两个店铺
    const tenant1 = await prisma.tenant.create({
        data: {
            name: '小时光',
            members: {
                create: {
                    userId: leo.id,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            },
        },
    });
    console.log(`店铺 "小时光" 已创建`);

    const tenant2 = await prisma.tenant.create({
        data: {
            name: '大时光',
            members: {
                create: {
                    userId: leo.id,
                    role: 'OWNER',
                    status: 'ACTIVE',
                },
            },
        },
    });
    console.log(`店铺 "大时光" 已创建`);

    // 4. 为这两个店铺导入配方数据
    await seedRecipesForTenant(tenant1.id, recipesData);
    await seedRecipesForTenant(tenant2.id, recipesData);

    console.log('种子脚本执行完毕！');
}

main()
    .catch((e) => {
        console.error('种子脚本执行失败:', e);
        process.exit(1);
    })
    .finally(() => {
        void prisma.$disconnect();
    });
