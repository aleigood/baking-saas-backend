// 路径: src/production-tasks/production-tasks.service.ts
// [核心修复] 修正 complete 函数中的库存检查逻辑，使其跳过 UNTRACKED (非追踪) 原料

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProductionTaskDto } from './dto/create-production-task.dto';
import { UpdateProductionTaskDto } from './dto/update-production-task.dto';
import { QueryProductionTaskDto } from './dto/query-production-task.dto';
import {
    Ingredient, // 导入 Ingredient
    IngredientType,
    Prisma,
    ProductIngredientType,
    ProductionTask,
    ProductionTaskStatus,
    RecipeCategory,
    RecipeFamily,
    RecipeType,
} from '@prisma/client';
import { CompleteProductionTaskDto } from './dto/complete-production-task.dto';
import { CostingService, CalculatedRecipeDetails } from '../costing/costing.service';
import { QueryTaskDetailDto } from './dto/query-task-detail.dto';
import { ComponentGroup, ProductDetails, TaskDetailResponseDto, TaskIngredientDetail } from './dto/task-detail.dto';
import { UpdateTaskDetailsDto } from './dto/update-task-details.dto';
import { BillOfMaterialsResponseDto, BillOfMaterialsItem, PrepTask } from './dto/preparation.dto';
import * as path from 'path';

// [核心修复] 禁用 require 和 unsafe-assignment 检查
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
const PdfPrinter = require('pdfmake');

const spoilageStages = [
    { key: 'kneading', label: '打面失败' },
    { key: 'fermentation', label: '发酵失败' },
    { key: 'shaping', label: '整形失败' },
    { key: 'baking', label: '烘烤失败' },
    { key: 'development', label: '新品研发' },
    { key: 'other', label: '其他原因' },
];

// 这个 include 对象不再用于 *查询*，而是用于 *让 Prisma 生成强类型*
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const taskWithDetailsInclude = {
    items: {
        include: {
            product: {
                include: {
                    recipeVersion: {
                        include: {
                            family: {
                                include: { outputIngredient: true }, // [核心新增]
                            },
                            components: {
                                include: {
                                    ingredients: {
                                        // L1
                                        include: {
                                            ingredient: { include: { activeSku: true } },
                                            linkedPreDough: {
                                                // L2
                                                include: {
                                                    outputIngredient: true, // [核心新增]
                                                    versions: {
                                                        where: { isActive: true },
                                                        include: {
                                                            components: {
                                                                include: {
                                                                    ingredients: {
                                                                        // L3
                                                                        include: {
                                                                            ingredient: true,
                                                                            linkedPreDough: {
                                                                                // L4
                                                                                include: {
                                                                                    outputIngredient: true, // [核心新增]
                                                                                    versions: {
                                                                                        where: { isActive: true },
                                                                                        include: {
                                                                                            components: {
                                                                                                include: {
                                                                                                    ingredients: {
                                                                                                        // L5
                                                                                                        include: {
                                                                                                            ingredient: true,
                                                                                                            linkedPreDough: true, // 停止在 L6
                                                                                                            linkedExtra: true, // 停止在 L6
                                                                                                        },
                                                                                                    },
                                                                                                },
                                                                                            },
                                                                                        },
                                                                                    },
                                                                                },
                                                                            },
                                                                            linkedExtra: {
                                                                                // L4
                                                                                include: {
                                                                                    outputIngredient: true, // [核心新增]
                                                                                    versions: {
                                                                                        where: { isActive: true },
                                                                                        include: {
                                                                                            components: {
                                                                                                include: {
                                                                                                    ingredients: {
                                                                                                        // L5
                                                                                                        include: {
                                                                                                            ingredient: true,
                                                                                                            linkedPreDough: true, // 停止在 L6
                                                                                                            linkedExtra: true, // 停止在 L6
                                                                                                        },
                                                                                                    },
                                                                                                },
                                                                                            },
                                                                                        },
                                                                                    },
                                                                                },
                                                                            },
                                                                        },
                                                                    },
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                            linkedExtra: {
                                                // L2
                                                include: {
                                                    outputIngredient: true, // [核心新增]
                                                    versions: {
                                                        where: { isActive: true },
                                                        include: {
                                                            components: {
                                                                include: {
                                                                    ingredients: {
                                                                        // L3
                                                                        include: {
                                                                            ingredient: true,
                                                                            linkedPreDough: {
                                                                                // L4
                                                                                include: {
                                                                                    outputIngredient: true, // [核心新增]
                                                                                    versions: {
                                                                                        where: { isActive: true },
                                                                                        include: {
                                                                                            components: {
                                                                                                include: {
                                                                                                    ingredients: {
                                                                                                        // L5
                                                                                                        include: {
                                                                                                            ingredient: true,
                                                                                                            linkedPreDough: true, // 停止在 L6
                                                                                                            linkedExtra: true, // 停止在 L6
                                                                                                        },
                                                                                                    },
                                                                                                },
                                                                                            },
                                                                                        },
                                                                                    },
                                                                                },
                                                                            },
                                                                            linkedExtra: {
                                                                                // L4
                                                                                include: {
                                                                                    outputIngredient: true, // [核心新增]
                                                                                    versions: {
                                                                                        where: { isActive: true },
                                                                                        include: {
                                                                                            components: {
                                                                                                include: {
                                                                                                    ingredients: {
                                                                                                        // L5
                                                                                                        include: {
                                                                                                            ingredient: true,
                                                                                                            linkedPreDough: true, // 停止在 L6
                                                                                                            linkedExtra: true, // 停止在 L6
                                                                                                        },
                                                                                                    },
                                                                                                },
                                                                                            },
                                                                                        },
                                                                                    },
                                                                                },
                                                                            },
                                                                        },
                                                                    },
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    ingredients: {
                        include: {
                            ingredient: { include: { activeSku: true } },
                            linkedExtra: {
                                include: {
                                    outputIngredient: true, // [核心新增]
                                    versions: {
                                        where: { isActive: true },
                                        include: {
                                            components: {
                                                include: {
                                                    ingredients: {
                                                        // L3
                                                        include: {
                                                            ingredient: true,
                                                            linkedPreDough: {
                                                                // L4
                                                                include: {
                                                                    outputIngredient: true, // [核心新增]
                                                                    versions: {
                                                                        where: { isActive: true },
                                                                        include: {
                                                                            components: {
                                                                                include: {
                                                                                    ingredients: {
                                                                                        // L5
                                                                                        include: {
                                                                                            ingredient: true,
                                                                                            linkedPreDough: true, // 停止在 L6
                                                                                            linkedExtra: true, // 停止在 L6
                                                                                        },
                                                                                    },
                                                                                },
                                                                            },
                                                                        },
                                                                    },
                                                                },
                                                            },
                                                            linkedExtra: {
                                                                // L4
                                                                include: {
                                                                    outputIngredient: true, // [核心新增]
                                                                    versions: {
                                                                        where: { isActive: true },
                                                                        include: {
                                                                            components: {
                                                                                include: {
                                                                                    ingredients: {
                                                                                        // L5
                                                                                        include: {
                                                                                            ingredient: true,
                                                                                            linkedPreDough: true, // 停止在 L6
                                                                                            linkedExtra: true, // 停止在 L6
                                                                                        },
                                                                                    },
                                                                                },
                                                                            },
                                                                        },
                                                                    },
                                                                },
                                                            },
                                                        },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    createdBy: {
        select: {
            name: true,
            phone: true,
        },
    },
};

// 用于递归批量查询的“浅层Include”
const recipeVersionRecursiveBatchInclude = {
    // 包含 family 信息，用于类型判断和组装
    family: {
        select: {
            id: true,
            name: true,
            type: true,
            category: true,
            outputIngredient: { select: { id: true, currentStockInGrams: true, shelfLife: true } }, // [核心新增]
        },
    },
    // 包含完整的 components 和 ingredients (这是快照的核心数据)
    components: {
        include: {
            ingredients: {
                include: {
                    // [核心] 获取完整的“基础原料”信息
                    ingredient: { include: { activeSku: true } },
                    // [核心] 对于“配方原料”，只获取下一层的 RecipeVersion ID
                    linkedPreDough: {
                        select: {
                            id: true, // Family ID
                            name: true,
                            type: true,
                            category: true,
                            outputIngredient: { select: { id: true, currentStockInGrams: true, shelfLife: true } }, // [核心新增]
                            versions: { where: { isActive: true }, select: { id: true } }, // <-- 下一个 RecipeVersion ID
                        },
                    },
                    // 支持 ComponentIngredient.linkedExtra
                    linkedExtra: {
                        select: {
                            id: true, // Family ID
                            name: true,
                            type: true,
                            category: true,
                            outputIngredient: { select: { id: true, currentStockInGrams: true, shelfLife: true } }, // [核心新增]
                            versions: { where: { isActive: true }, select: { id: true } }, // <-- 下一个 RecipeVersion ID
                        },
                    },
                },
            },
        },
    },
    // 包含完整的 products 和 product ingredients
    products: {
        where: { deletedAt: null },
        include: {
            ingredients: {
                include: {
                    // [核心] 获取完整的“基础原料”信息
                    ingredient: { include: { activeSku: true } },
                    // [核心] 对于“配方原料”，只获取下一层的 RecipeVersion ID
                    linkedExtra: {
                        select: {
                            id: true, // Family ID
                            name: true,
                            type: true,
                            category: true,
                            outputIngredient: { select: { id: true, currentStockInGrams: true, shelfLife: true } }, // [核心新增]
                            versions: { where: { isActive: true }, select: { id: true } }, // <-- 下一个 RecipeVersion ID
                        },
                    },
                },
            },
        },
    },
};
// 定义上述 include 的 TS 类型
type FetchedRecipeVersion = Prisma.RecipeVersionGetPayload<{
    include: typeof recipeVersionRecursiveBatchInclude;
}>;

// 任务列表 include
const taskListItemsInclude = {
    items: {
        select: {
            quantity: true,
            product: {
                select: {
                    id: true,
                    name: true,
                    // [核心修改] 增加品类字段，用于前端区分展示
                    recipeVersion: {
                        select: {
                            family: {
                                select: {
                                    category: true,
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    createdBy: {
        select: {
            name: true,
            phone: true,
        },
    },
};

// 基于 Prisma GetPayload 的强类型定义
type TaskWithDetails = Prisma.ProductionTaskGetPayload<{
    include: typeof taskWithDetailsInclude;
}>;

type TaskItemWithDetails = TaskWithDetails['items'][0];
type ProductWithDetails = TaskItemWithDetails['product'];
type ComponentWithIngredients = ProductWithDetails['recipeVersion']['components'][0];
type ComponentWithRecursiveIngredients = ProductWithDetails['recipeVersion']['components'][0];

type PrepItemFamily = RecipeFamily & {
    outputIngredient?: { id: string; currentStockInGrams: Prisma.Decimal } | null;
};
type RequiredPrepItem = { family: PrepItemFamily; totalWeight: Prisma.Decimal };

// 快照中用于递归计算的配方家族类型定义 (存根)
type SnapshotRecipeFamilyStub = {
    id: string;
    name: string;
    type: RecipeType;
    category: RecipeCategory;
    outputIngredient?: { id: string; currentStockInGrams: string | number } | null; // [核心新增]
    versions: {
        id: string;
        notes: string | null;
        components: {
            procedure: string[];
            lossRatio: number | string | null;
            ingredients: {
                ratio: number | string | null;
                ingredient: { id: string; isFlour: boolean } | null;
                linkedPreDough: {
                    id: string; // family.id
                    outputIngredient?: { id: string; currentStockInGrams: string | number } | null; // [核心新增]
                    versions: {
                        id: string; // version.id
                        components: {
                            ingredients: {
                                ratio: number | string | null;
                                // 嵌套的 pre-dough
                                linkedPreDough: {
                                    id: string;
                                    versions: { id: string }[];
                                } | null;
                                // 嵌套的 extra
                                linkedExtra: {
                                    id: string;
                                    versions: { id: string }[];
                                } | null;
                            }[];
                        }[];
                    }[];
                } | null;
                linkedExtra: {
                    id: string; // family.id
                    outputIngredient?: { id: string; currentStockInGrams: string | number } | null; // [核心新增]
                    versions: {
                        id: string; // version.id
                        components: {
                            ingredients: {
                                ratio: number | string | null;
                                linkedPreDough: {
                                    id: string;
                                    versions: { id: string }[];
                                } | null;
                                linkedExtra: {
                                    id: string;
                                    versions: { id: string }[];
                                } | null;
                            }[];
                        }[];
                    }[];
                } | null;
            }[];
        }[];
    }[];
};

type FlattenedIngredient = {
    id: string;
    name: string;
    weight: Prisma.Decimal;
    brand: string | null;
    isRecipe: boolean;
    recipeType?: RecipeType;
    recipeFamily?: PrepItemFamily;
    type?: ProductIngredientType;
    ratio?: Prisma.Decimal;
    weightInGrams?: Prisma.Decimal;
    waterContent?: Prisma.Decimal;
};

// [新增] 为 PDF 生成辅助函数定义的接口
interface RenderTaskItem {
    name: string;
    totalWeight: number;
    targetWeight?: number;
    ingredients: {
        name: string;
        isRecipe: boolean;
        brand?: string | null;
        extraInfo?: string | null;
        weightInGrams: number;
    }[];
    procedure?: string[];
}

type SortableTaskIngredient = TaskIngredientDetail & { isFlour?: boolean };
type CalculatedRecipeIngredient = Omit<TaskIngredientDetail, 'id'> & { ingredientId: string };

@Injectable()
export class ProductionTasksService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly costingService: CostingService,
    ) {}

    // 辅助函数：批量递归获取所有 RecipeVersion
    private async _fetchRecursiveRecipeVersions(
        initialVersionIds: string[],
        tx: Prisma.TransactionClient,
    ): Promise<Map<string, FetchedRecipeVersion>> {
        const versionsToFetch = new Set<string>(initialVersionIds); // 跟踪所有已发现的ID (防重)
        const versionsInQueue = [...initialVersionIds]; // “待办”队列
        const allFetchedVersions = new Map<string, FetchedRecipeVersion>(); // “仓库”

        while (versionsInQueue.length > 0) {
            const batchIds = [...new Set(versionsInQueue.splice(0))]; // 取出当前队列所有ID

            // 批量查询
            const results = await tx.recipeVersion.findMany({
                where: { id: { in: batchIds } },
                include: recipeVersionRecursiveBatchInclude, // 使用我们定义的递归 include
            });

            // 分析
            for (const version of results) {
                // 存入“仓库”
                if (!allFetchedVersions.has(version.id)) {
                    allFetchedVersions.set(version.id, version);

                    // 深度优先：查找下一层的新ID
                    // 遍历 Components
                    for (const component of version.components) {
                        for (const ing of component.ingredients) {
                            // 检查 PreDough
                            const nextPreDoughId = ing.linkedPreDough?.versions[0]?.id;
                            if (nextPreDoughId && !versionsToFetch.has(nextPreDoughId)) {
                                versionsToFetch.add(nextPreDoughId);
                                versionsInQueue.push(nextPreDoughId); // 放入“待办”队列
                            }
                            // 检查 Extra
                            const nextExtraId = ing.linkedExtra?.versions[0]?.id;
                            if (nextExtraId && !versionsToFetch.has(nextExtraId)) {
                                versionsToFetch.add(nextExtraId);
                                versionsInQueue.push(nextExtraId); // 放入“待办”队列
                            }
                        }
                    }
                    // 遍历 Products
                    for (const product of version.products) {
                        for (const pIng of product.ingredients) {
                            // 检查 Extra
                            const nextVersionId = pIng.linkedExtra?.versions[0]?.id;
                            if (nextVersionId && !versionsToFetch.has(nextVersionId)) {
                                versionsToFetch.add(nextVersionId);
                                versionsInQueue.push(nextVersionId); // 放入“待办”队列
                            }
                        }
                    }
                }
            }
        }
        // 循环结束，返回完整的“仓库”
        return allFetchedVersions;
    }

    // 核心函数：获取并“组装”完整的任务详情
    private async _getTaskWithAssembledDetails(taskId: string, tx: Prisma.TransactionClient): Promise<TaskWithDetails> {
        // Query 1 (L1)：获取“浅层”的任务信息
        const shallowTaskInclude = {
            items: {
                include: {
                    product: {
                        // [核心] 只 select 顶层产品和 L1 的 RecipeVersion ID
                        select: {
                            id: true,
                            recipeVersionId: true,
                            name: true,
                            baseDoughWeight: true,
                            procedure: true,
                            deletedAt: true,
                            ingredients: {
                                // L2
                                include: {
                                    ingredient: { include: { activeSku: true } }, // 基础原料
                                    linkedExtra: {
                                        // 配方原料 (L2)
                                        select: {
                                            id: true,
                                            name: true,
                                            type: true,
                                            category: true,
                                            versions: { where: { isActive: true }, select: { id: true } }, // L2 ID
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            createdBy: {
                select: {
                    name: true,
                    phone: true,
                },
            },
        };

        const task = await tx.productionTask.findUnique({
            where: { id: taskId },
            include: shallowTaskInclude,
        });

        if (!task) {
            throw new NotFoundException('任务未找到 (ID: ${taskId})');
        }

        // 初始化：收集所有 L1 和 L2 的 RecipeVersion ID
        const initialVersionIds = new Set<string>();
        for (const item of task.items) {
            if (item.product.recipeVersionId) {
                initialVersionIds.add(item.product.recipeVersionId);
            }
            for (const pIng of item.product.ingredients) {
                if (pIng.linkedExtra?.versions[0]?.id) {
                    initialVersionIds.add(pIng.linkedExtra.versions[0].id);
                }
            }
        }

        // 调用批量递归获取，拿到所有“碎片”
        const versionMap = await this._fetchRecursiveRecipeVersions(Array.from(initialVersionIds), tx);

        // 组装 (Assemble)：使用 memoization 来防止循环依赖
        const stitchedVersionsCache = new Map<string, FetchedRecipeVersion | null>();

        const stitchVersionTree = (versionId: string): FetchedRecipeVersion | null => {
            // 检查缓存 (防重/防循环)
            if (stitchedVersionsCache.has(versionId)) {
                return stitchedVersionsCache.get(versionId)!;
            }

            const versionData = versionMap.get(versionId);
            if (!versionData) {
                stitchedVersionsCache.set(versionId, null); // 标记为 null
                return null;
            }

            // [核心] 复制一份数据，避免修改 map 中的原始缓存
            // structuredClone 是一个现代且安全的方式
            const version = JSON.parse(JSON.stringify(versionData)) as FetchedRecipeVersion;

            // 标记此ID正在处理中 (用于循环依赖检测)
            stitchedVersionsCache.set(versionId, null);

            // 递归组装 Components (linkedPreDough 和 linkedExtra)
            for (const component of version.components) {
                for (const ing of component.ingredients) {
                    // 组装 PreDough
                    const nextVersionId = ing.linkedPreDough?.versions[0]?.id;
                    if (nextVersionId) {
                        // 递归调用
                        const stitchedSubVersion = stitchVersionTree(nextVersionId);
                        if (stitchedSubVersion) {
                            // 将子配方的家族信息，附加到 linkedPreDough 对象上 (模拟旧数据结构)
                            ing.linkedPreDough = {
                                ...ing.linkedPreDough,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion], // [核心] 替换掉 [ {id: '...'} ]
                            };
                        }
                    }

                    // 补上 ComponentIngredient.linkedExtra 的递归组装
                    const nextExtraVersionId = ing.linkedExtra?.versions[0]?.id;
                    if (nextExtraVersionId) {
                        const stitchedSubVersion = stitchVersionTree(nextExtraVersionId);
                        if (stitchedSubVersion) {
                            ing.linkedExtra = {
                                ...ing.linkedExtra,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                }
            }

            // 递归组装 Products (linkedExtra)
            for (const product of version.products) {
                for (const pIng of product.ingredients) {
                    const nextVersionId = pIng.linkedExtra?.versions[0]?.id;
                    if (nextVersionId) {
                        const stitchedSubVersion = stitchVersionTree(nextVersionId);
                        if (stitchedSubVersion) {
                            pIng.linkedExtra = {
                                ...pIng.linkedExtra,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                }
            }

            // 存入缓存并返回
            stitchedVersionsCache.set(versionId, version);
            return version;
        };

        // 启动组装
        // [核心] 我们必须修改 `task` 对象本身，将其从“浅层”变为“深层”
        const assembledTask = JSON.parse(JSON.stringify(task)) as typeof task; // 深度复制 task
        for (const item of assembledTask.items) {
            // 组装 Main Recipe
            const topLevelVersionId = item.product.recipeVersionId;
            if (topLevelVersionId) {
                const stitchedL1Version = stitchVersionTree(topLevelVersionId);
                if (stitchedL1Version) {
                    // 将 family 注入，模拟旧结构
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                    (item.product as any).recipeVersion = {
                        ...stitchedL1Version,
                        family: stitchedL1Version.family,
                    };
                }
            }
            // 组装 Product Ingredients
            for (const pIng of item.product.ingredients) {
                const l2VersionId = pIng.linkedExtra?.versions[0]?.id;
                if (l2VersionId) {
                    const stitchedL2Version = stitchVersionTree(l2VersionId);
                    if (stitchedL2Version) {
                        pIng.linkedExtra = {
                            ...pIng.linkedExtra,
                            ...stitchedL2Version.family,
                            versions: [stitchedL2Version],
                        };
                    }
                }
            }
        }

        // 类型断言：这是我们隔离 `any` 的唯一地方。
        return assembledTask as unknown as TaskWithDetails;
    }

    // 获取任务详情并序列化为快照
    private async _fetchAndSerializeSnapshot(
        taskId: string,
        tx?: Prisma.TransactionClient,
    ): Promise<Prisma.JsonObject> {
        const prismaClient = tx || this.prisma;

        // 调用“组装”函数
        const taskWithDetails = await this._getTaskWithAssembledDetails(taskId, prismaClient);

        if (!taskWithDetails) {
            // _getTaskWithAssembledDetails 内部会抛出 NotFoundException
            throw new NotFoundException('无法生成快照：任务未找到。');
        }

        // 过滤已删除产品的逻辑
        const snapshot = {
            ...taskWithDetails,
            items: taskWithDetails.items.filter((item) => !item.product.deletedAt),
        };

        return snapshot as unknown as Prisma.JsonObject;
    }

    private _sortTaskIngredients(
        ingredients: SortableTaskIngredient[],
        category: RecipeCategory,
        type: RecipeType,
    ): SortableTaskIngredient[] {
        const isFlourSort = type === 'PRE_DOUGH' || category === 'BREAD';

        return ingredients.sort((a, b) => {
            const aIsRecipe = a.isRecipe ?? false;
            const bIsRecipe = b.isRecipe ?? false;
            if (aIsRecipe && !bIsRecipe) return -1;
            if (!aIsRecipe && bIsRecipe) return 1;

            if (isFlourSort) {
                const aIsFlour = a.isFlour ?? false;
                const bIsFlour = b.isFlour ?? false;

                if (aIsFlour && !bIsFlour) return -1;
                if (!aIsFlour && bIsFlour) return 1;
            }

            const aWeight = a.weightInGrams ?? 0;
            const bWeight = b.weightInGrams ?? 0;
            return bWeight - aWeight;
        });
    }

    private _sanitizeTask(task: TaskWithDetails) {
        return {
            ...task,
            items: task.items.map((item: TaskItemWithDetails) => ({
                ...item,
                product: {
                    ...item.product,
                    baseDoughWeight: new Prisma.Decimal(item.product.baseDoughWeight).toNumber(),
                    recipeVersion: {
                        ...item.product.recipeVersion,
                        components: item.product.recipeVersion.components.map((component) => ({
                            ...component,
                            targetTemp: component.targetTemp
                                ? new Prisma.Decimal(component.targetTemp).toNumber()
                                : null,
                            lossRatio: component.lossRatio ? new Prisma.Decimal(component.lossRatio).toNumber() : null,
                            divisionLoss: component.divisionLoss
                                ? new Prisma.Decimal(component.divisionLoss).toNumber()
                                : null,
                            ingredients: component.ingredients.map((ing) => ({
                                ...ing,
                                ratio: ing.ratio ? new Prisma.Decimal(ing.ratio).toNumber() : null,
                                flourRatio: ing.flourRatio ? new Prisma.Decimal(ing.flourRatio).toNumber() : null,
                                ingredient: ing.ingredient
                                    ? {
                                          ...ing.ingredient,
                                          waterContent: new Prisma.Decimal(ing.ingredient.waterContent).toNumber(),
                                          currentStockInGrams: new Prisma.Decimal(
                                              ing.ingredient.currentStockInGrams,
                                          ).toNumber(),
                                          currentStockValue: new Prisma.Decimal(
                                              ing.ingredient.currentStockValue,
                                          ).toNumber(),
                                      }
                                    : null,
                            })),
                        })),
                    },
                    ingredients: item.product.ingredients.map((pIng) => ({
                        ...pIng,
                        ratio: pIng.ratio ? new Prisma.Decimal(pIng.ratio).toNumber() : null,
                        weightInGrams: pIng.weightInGrams ? new Prisma.Decimal(pIng.weightInGrams).toNumber() : null,
                    })),
                },
            })),
        };
    }

    // 修正为行业标准公式 Tw = (Td * 3) - Tf - Ta - F
    private _calculateWaterTemp(targetTemp: number, mixerType: number, flourTemp: number, ambientTemp: number): number {
        return targetTemp * 3 - flourTemp - ambientTemp - mixerType;
    }

    // 修正冰量计算公式的分母
    private _calculateIce(targetWaterTemp: number, totalWater: number, initialWaterTemp: number): number {
        if (targetWaterTemp >= initialWaterTemp) {
            return 0;
        }

        const Ti = new Prisma.Decimal(initialWaterTemp);
        const Tw = new Prisma.Decimal(targetWaterTemp);
        const W = new Prisma.Decimal(totalWater);

        const denominator = new Prisma.Decimal(80).add(Tw);

        if (denominator.isZero() || denominator.isNegative()) {
            return totalWater + 1;
        }

        const numerator = W.mul(Ti.sub(Tw));
        const ice = numerator.div(denominator);
        return ice.toNumber();
    }

    private _calculateRequiredWetIngredientTemp(
        targetWaterTemp: number,
        totalRecipeWater: number,
        availableWaterToReplace: number,
    ): number {
        if (availableWaterToReplace - totalRecipeWater === 0) {
            return 0;
        }
        return (
            (-totalRecipeWater * targetWaterTemp - 80 * availableWaterToReplace) /
            (availableWaterToReplace - totalRecipeWater)
        );
    }

    async create(tenantId: string, userId: string, createProductionTaskDto: CreateProductionTaskDto) {
        const { startDate, endDate, notes, products } = createProductionTaskDto;

        if (!products || products.length === 0) {
            throw new BadRequestException('一个生产任务至少需要包含一个产品。');
        }

        const productIds = products.map((p) => p.productId);

        const existingProducts = await this.prisma.product.findMany({
            where: {
                id: { in: productIds },
                recipeVersion: { family: { tenantId } },
                deletedAt: null,
            },
            include: {
                recipeVersion: {
                    include: {
                        family: {
                            select: {
                                deletedAt: true,
                                name: true,
                                category: true,
                            },
                        },
                    },
                },
            },
        });

        if (existingProducts.length !== productIds.length) {
            throw new NotFoundException('一个或多个目标产品不存在或不属于该店铺。');
        }

        const discontinuedProducts = existingProducts.filter((p) => p.recipeVersion.family.deletedAt !== null);
        if (discontinuedProducts.length > 0) {
            const names = [...new Set(discontinuedProducts.map((p) => p.recipeVersion.family.name))].join('", "');
            throw new BadRequestException(`无法创建任务，因为配方 "${names}" 已被停用。`);
        }

        const firstCategory = existingProducts[0].recipeVersion.family.category;
        const allSameCategory = existingProducts.every((p) => p.recipeVersion.family.category === firstCategory);

        if (!allSameCategory) {
            throw new BadRequestException('一次生产任务只能包含同一品类的产品。');
        }

        // 库存检查
        // 获取所有产品“外壳”，用于收集 L1 和 L2 ID
        const productShells = await this.prisma.product.findMany({
            where: { id: { in: productIds }, deletedAt: null },
            // 这是一个“浅层”查询，只为了拿到 L1/L2 ID 和组装所需的基础字段
            select: {
                id: true,
                recipeVersionId: true, // L1 ID
                name: true,
                baseDoughWeight: true,
                procedure: true,
                deletedAt: true,
                ingredients: {
                    // L2
                    include: {
                        ingredient: { include: { activeSku: true } }, // 基础原料
                        linkedExtra: {
                            // 配方原料 (L2)
                            select: {
                                id: true,
                                name: true,
                                type: true,
                                category: true,
                                versions: { where: { isActive: true }, select: { id: true } }, // L2 ID
                            },
                        },
                    },
                },
                // 我们还需要 L1 的 family，以便注入
                recipeVersion: {
                    select: {
                        family: true,
                    },
                },
            },
        });

        const productShellMap = new Map(productShells.map((p) => [p.id, p]));

        // 收集所有 L1 和 L2 的 RecipeVersion ID
        const initialVersionIds = new Set<string>();
        for (const shell of productShells) {
            if (shell.recipeVersionId) {
                initialVersionIds.add(shell.recipeVersionId);
            }
            for (const pIng of shell.ingredients) {
                if (pIng.linkedExtra?.versions[0]?.id) {
                    initialVersionIds.add(pIng.linkedExtra.versions[0].id);
                }
            }
        }

        // 调用“仓库”函数，获取所有配方“碎片”
        // [核心] 注意：这里使用的是 this.prisma，因为我们尚未进入 $transaction
        const versionMap = await this._fetchRecursiveRecipeVersions(Array.from(initialVersionIds), this.prisma);

        // 组装逻辑
        const stitchedVersionsCache = new Map<string, FetchedRecipeVersion | null>();
        const stitchVersionTree = (versionId: string): FetchedRecipeVersion | null => {
            if (stitchedVersionsCache.has(versionId)) {
                return stitchedVersionsCache.get(versionId)!;
            }

            const versionData = versionMap.get(versionId);
            if (!versionData) {
                stitchedVersionsCache.set(versionId, null); // 标记为 null
                return null;
            }
            const version = JSON.parse(JSON.stringify(versionData)) as FetchedRecipeVersion;

            stitchedVersionsCache.set(versionId, null);

            for (const component of version.components) {
                for (const ing of component.ingredients) {
                    const nextVersionId = ing.linkedPreDough?.versions[0]?.id;
                    if (nextVersionId) {
                        const stitchedSubVersion = stitchVersionTree(nextVersionId);
                        if (stitchedSubVersion) {
                            ing.linkedPreDough = {
                                ...ing.linkedPreDough,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                    const nextExtraVersionId = ing.linkedExtra?.versions[0]?.id;
                    if (nextExtraVersionId) {
                        const stitchedSubVersion = stitchVersionTree(nextExtraVersionId);
                        if (stitchedSubVersion) {
                            ing.linkedExtra = {
                                ...ing.linkedExtra,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                }
            }

            for (const product of version.products) {
                for (const pIng of product.ingredients) {
                    const nextVersionId = pIng.linkedExtra?.versions[0]?.id;
                    if (nextVersionId) {
                        const stitchedSubVersion = stitchVersionTree(nextVersionId);
                        if (stitchedSubVersion) {
                            pIng.linkedExtra = {
                                ...pIng.linkedExtra,
                                ...stitchedSubVersion.family,
                                versions: [stitchedSubVersion],
                            };
                        }
                    }
                }
            }

            stitchedVersionsCache.set(versionId, version);
            return version;
        };

        // 组装并计算所有消耗
        const allConsumptions = new Map<
            string,
            { ingredientId: string; ingredientName: string; totalConsumed: number }
        >();

        for (const item of products) {
            // `products` 是 DTO: { productId, quantity }
            const shell = productShellMap.get(item.productId);
            if (!shell) continue;

            // 组装 (Stitch)
            const assembledProduct = JSON.parse(JSON.stringify(shell)) as typeof shell; // 深度复制“外壳”

            // 组装 Main Recipe
            const topLevelVersionId = shell.recipeVersionId;
            if (topLevelVersionId) {
                const stitchedL1Version = stitchVersionTree(topLevelVersionId);
                if (stitchedL1Version) {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                    (assembledProduct as any).recipeVersion = {
                        ...stitchedL1Version,
                        family: shell.recipeVersion.family, // 保持 L1 的 family
                    };
                }
            }
            // 组装 Product Ingredients
            for (const pIng of assembledProduct.ingredients) {
                const l2VersionId = pIng.linkedExtra?.versions[0]?.id;
                if (l2VersionId) {
                    const stitchedL2Version = stitchVersionTree(l2VersionId);
                    if (stitchedL2Version) {
                        pIng.linkedExtra = {
                            ...pIng.linkedExtra,
                            ...stitchedL2Version.family,
                            versions: [stitchedL2Version],
                        };
                    }
                }
            }

            // 创建模拟对象，类型断言为 ProductWithDetails
            const mockProductWithDetails = assembledProduct as unknown as ProductWithDetails;

            // [核心] 现在这个调用是安全的，`mockProductWithDetails` 是无限深度的
            const consumptions = this._getFlattenedIngredientsForBOM(mockProductWithDetails);

            // 聚合消耗
            for (const [ingredientId, weight] of consumptions.entries()) {
                const totalWeight = weight.mul(item.quantity);
                const existing = allConsumptions.get(ingredientId);
                if (existing) {
                    existing.totalConsumed += totalWeight.toNumber();
                } else {
                    allConsumptions.set(ingredientId, {
                        ingredientId: ingredientId,
                        ingredientName: '', // 后面批量填充
                        totalConsumed: totalWeight.toNumber(),
                    });
                }
            }
        }

        // [优化] 批量获取原料名称
        const allIngredientIds = Array.from(allConsumptions.keys());
        if (allIngredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: allIngredientIds } },
                select: { id: true, name: true },
            });
            const ingredientNameMap = new Map(ingredients.map((i) => [i.id, i.name]));
            for (const consumption of allConsumptions.values()) {
                consumption.ingredientName = ingredientNameMap.get(consumption.ingredientId) || '未知原料';
            }
        }

        // [核心] 后续逻辑保持不变
        const finalConsumptions = Array.from(allConsumptions.values());
        let stockWarning: string | null = null;
        if (finalConsumptions.length > 0) {
            // ... (库存检查逻辑)
            const ingredientIds = finalConsumptions.map((c) => c.ingredientId);
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, type: true },
            });
            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);
            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];
            for (const consumption of finalConsumptions) {
                const ingredient = ingredientStockMap.get(consumption.ingredientId);
                if (ingredient && new Prisma.Decimal(ingredient.currentStockInGrams).lt(consumption.totalConsumed)) {
                    insufficientIngredients.push(ingredient.name);
                }
            }
            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }

        const createdTask = await this.prisma.$transaction(async (tx) => {
            const task = await tx.productionTask.create({
                data: {
                    startDate,
                    endDate,
                    notes,
                    tenantId,
                    createdById: userId,
                    items: {
                        create: products.map((p) => ({
                            productId: p.productId,
                            quantity: p.quantity,
                        })),
                    },
                },
            });

            // 调用新的快照生成器
            const snapshot = await this._fetchAndSerializeSnapshot(task.id, tx);

            // 仅更新快照
            await tx.productionTask.update({
                where: { id: task.id },
                data: {
                    recipeSnapshot: snapshot,
                },
            });

            // 调用“组装”函数来获取返回数据
            return await this._getTaskWithAssembledDetails(task.id, tx);
        });

        // _sanitizeTask 现在接收的是我们组装好的对象
        return { task: this._sanitizeTask(createdTask), warning: stockWarning };
    }

    /**
     * 此方法现在基于“快照”计算预制件需求
     * 此函数现在是同步的
     */
    private _getPrepItemsForTask(tenantId: string, task: TaskWithDetails): CalculatedRecipeDetails[] {
        if (!task || !task.items || task.items.length === 0) {
            return [];
        }

        const requiredPrepItems = new Map<string, RequiredPrepItem>();
        const visitedRecipes = new Set<string>();

        const resolveDependencies = (
            versionId: string,
            family: SnapshotRecipeFamilyStub,
            requiredWeight: Prisma.Decimal,
        ) => {
            if (visitedRecipes.has(versionId)) return;
            visitedRecipes.add(versionId);

            const preDoughFamily = family;
            if (!preDoughFamily || !preDoughFamily.versions[0]?.components[0]) return;

            const activeVersion = preDoughFamily.versions[0];
            const mainComponent = activeVersion.components[0];

            const totalRatio = mainComponent.ingredients.reduce(
                (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
                new Prisma.Decimal(0),
            );

            if (totalRatio.isZero()) return;
            const weightPerRatioPoint = requiredWeight.div(totalRatio);

            for (const ing of mainComponent.ingredients) {
                const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                if (ing.linkedPreDough) {
                    const subVersion = ing.linkedPreDough.versions[0];
                    if (!subVersion) continue;
                    const subVersionId = subVersion.id;

                    const existing = requiredPrepItems.get(subVersionId);
                    if (existing) {
                        existing.totalWeight = existing.totalWeight.add(weight);
                    } else {
                        requiredPrepItems.set(subVersionId, {
                            family: ing.linkedPreDough as unknown as PrepItemFamily,
                            totalWeight: weight,
                        });
                    }
                    resolveDependencies(
                        subVersionId,
                        ing.linkedPreDough as unknown as SnapshotRecipeFamilyStub,
                        weight,
                    );
                }

                // 递归检查 ComponentIngredient.linkedExtra
                if (ing.linkedExtra) {
                    const subVersion = ing.linkedExtra.versions[0];
                    if (!subVersion) continue;
                    const subVersionId = subVersion.id;

                    const existing = requiredPrepItems.get(subVersionId);
                    if (existing) {
                        existing.totalWeight = existing.totalWeight.add(weight);
                    } else {
                        requiredPrepItems.set(subVersionId, {
                            family: ing.linkedExtra as unknown as PrepItemFamily,
                            totalWeight: weight,
                        });
                    }
                    resolveDependencies(subVersionId, ing.linkedExtra as unknown as SnapshotRecipeFamilyStub, weight);
                }
            }
        };

        for (const item of task.items) {
            const product = item.product;
            if (!product) continue;
            if (product.deletedAt) continue;

            const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
            if (!product.recipeVersion) continue;

            for (const component of product.recipeVersion.components) {
                for (const ing of component.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughFamily = ing.linkedPreDough;
                        // 快照中 [0] 总是 active
                        const preDoughVersion = preDoughFamily.versions[0];
                        const preDoughRecipe = preDoughVersion?.components[0];

                        if (preDoughRecipe && preDoughVersion) {
                            const preDoughVersionId = preDoughVersion.id;
                            const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                                (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                                new Prisma.Decimal(0),
                            );
                            const weight = totalFlourWeight
                                .mul(new Prisma.Decimal(ing.flourRatio))
                                .mul(preDoughTotalRatio)
                                .mul(item.quantity);

                            const existing = requiredPrepItems.get(preDoughVersionId);
                            if (existing) {
                                existing.totalWeight = existing.totalWeight.add(weight);
                            } else {
                                requiredPrepItems.set(preDoughVersionId, {
                                    family: preDoughFamily,
                                    totalWeight: weight,
                                });
                            }
                            resolveDependencies(
                                preDoughVersionId,
                                preDoughFamily as unknown as SnapshotRecipeFamilyStub,
                                weight,
                            );
                        }
                    }

                    // 检查 ComponentIngredient.linkedExtra
                    if (ing.linkedExtra && ing.ratio) {
                        const extraFamily = ing.linkedExtra;
                        const extraVersion = extraFamily.versions[0];
                        const extraRecipe = extraVersion?.components[0];

                        if (extraRecipe && extraVersion) {
                            const extraVersionId = extraVersion.id;
                            // 面包/面种类引用 EXTRA，使用面粉基准
                            const weight = totalFlourWeight.mul(new Prisma.Decimal(ing.ratio)).mul(item.quantity);

                            const existing = requiredPrepItems.get(extraVersionId);
                            if (existing) {
                                existing.totalWeight = existing.totalWeight.add(weight);
                            } else {
                                requiredPrepItems.set(extraVersionId, {
                                    family: extraFamily,
                                    totalWeight: weight,
                                });
                            }
                            resolveDependencies(
                                extraVersionId,
                                extraFamily as unknown as SnapshotRecipeFamilyStub,
                                weight,
                            );
                        }
                    }
                }
            }

            for (const pIng of product.ingredients) {
                if (pIng.linkedExtra) {
                    const extraFamily = pIng.linkedExtra;
                    const extraVersion = extraFamily.versions[0];
                    const extraRecipe = extraVersion?.components[0];

                    if (extraRecipe && extraVersion) {
                        const extraVersionId = extraVersion.id;
                        let weight = new Prisma.Decimal(0);
                        if (pIng.weightInGrams) {
                            weight = new Prisma.Decimal(pIng.weightInGrams).mul(item.quantity);
                        } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                            weight = totalFlourWeight.mul(new Prisma.Decimal(pIng.ratio)).mul(item.quantity);
                        }

                        const existing = requiredPrepItems.get(extraVersionId);
                        if (existing) {
                            existing.totalWeight = existing.totalWeight.add(weight);
                        } else {
                            requiredPrepItems.set(extraVersionId, {
                                family: extraFamily,
                                totalWeight: weight,
                            });
                        }
                        resolveDependencies(extraVersionId, extraFamily as unknown as SnapshotRecipeFamilyStub, weight);
                    }
                }
            }
        }

        if (requiredPrepItems.size === 0) {
            return [];
        }

        const prepTaskItems: CalculatedRecipeDetails[] = [];
        for (const [, data] of requiredPrepItems.entries()) {
            // [核心新增] 计算剩余需求量：总需求 - 当前库存
            let remainingNeed = data.totalWeight;
            if (data.family.outputIngredient) {
                const currentStock = new Prisma.Decimal(data.family.outputIngredient.currentStockInGrams);
                remainingNeed = data.totalWeight.sub(currentStock);
            }

            // 如果库存充足，不再添加到待制作列表
            if (remainingNeed.lte(0)) {
                continue;
            }

            // 使用剩余需求量计算BOM
            const details = this.costingService.getCalculatedRecipeDetailsFromSnapshot(
                data.family,
                remainingNeed.toNumber(),
            );

            const recipeFamily = data.family as unknown as SnapshotRecipeFamilyStub;
            const mainComponent = recipeFamily.versions[0]?.components[0];
            const procedure = mainComponent?.procedure;
            const activeVersion = recipeFamily.versions[0];
            const versionName = activeVersion?.notes;

            if (details.name && versionName) {
                details.name = `${details.name} (${versionName})`;
            }

            if (procedure && mainComponent && details.ingredients && details.ingredients.length > 0) {
                const totalRatio = mainComponent.ingredients.reduce(
                    (sum, ing) => sum.add(new Prisma.Decimal(ing.ratio ?? 0)),
                    new Prisma.Decimal(0),
                );
                let baseForPercentageCalc = new Prisma.Decimal(details.totalWeight);
                if (!totalRatio.isZero()) {
                    baseForPercentageCalc = new Prisma.Decimal(details.totalWeight).div(totalRatio);
                }

                const { processedProcedure, ingredientNotes } = this._parseAndCalculateProcedureNotes(
                    procedure,
                    baseForPercentageCalc,
                );
                details.procedure = processedProcedure;

                if (recipeFamily && details.ingredients && details.ingredients.length > 0) {
                    const ingredientInfoMap = new Map(
                        mainComponent.ingredients.map((i) =>
                            i.ingredient ? [i.ingredient.id, { isFlour: i.ingredient.isFlour }] : [null, null],
                        ),
                    );
                    const ingredientsForSortingAndNotes: SortableTaskIngredient[] = (
                        details.ingredients as CalculatedRecipeIngredient[]
                    ).map((ing) => ({
                        id: ing.ingredientId,
                        name: ing.name,
                        weightInGrams: ing.weightInGrams,
                        brand: ing.brand ?? null,
                        isRecipe: ing.isRecipe,
                        extraInfo: null,
                        isFlour: ingredientInfoMap.get(ing.ingredientId)?.isFlour ?? false,
                    }));

                    const sortedIngredients = this._sortTaskIngredients(
                        ingredientsForSortingAndNotes,
                        recipeFamily.category,
                        recipeFamily.type,
                    );

                    if (ingredientNotes.size > 0) {
                        sortedIngredients.forEach((ingredient: TaskIngredientDetail) => {
                            const note = ingredientNotes.get(ingredient.name);
                            if (note) {
                                const existingInfo = ingredient.extraInfo ? `${ingredient.extraInfo}\n` : '';
                                ingredient.extraInfo = `${existingInfo}${note}`;
                            }
                        });
                    }

                    details.ingredients = sortedIngredients.map((ing) => ({
                        ingredientId: ing.id,
                        name: ing.name,
                        weightInGrams: ing.weightInGrams,
                        brand: ing.brand,
                        isRecipe: ing.isRecipe,
                        extraInfo: ing.extraInfo,
                    }));
                }
            }
            prepTaskItems.push(details);
        }

        return prepTaskItems;
    }

    private async _getPrepTaskSummary(
        tenantId: string,
        date?: string,
    ): Promise<Omit<PrepTask, 'items' | 'billOfMaterials'> | null> {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const tasksStartingToday = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
                items: {
                    some: {
                        product: { deletedAt: null },
                    },
                },
                recipeSnapshot: { not: Prisma.JsonNull },
            },
            select: {
                recipeSnapshot: true,
            },
        });

        if (tasksStartingToday.length === 0) {
            return null;
        }

        const snapshotTasks = tasksStartingToday
            .map((task) => {
                if (!task.recipeSnapshot) return null;
                return task.recipeSnapshot as unknown as TaskWithDetails;
            })
            .filter((t): t is TaskWithDetails => t !== null);

        if (snapshotTasks.length === 0) {
            return null;
        }

        const combinedTaskItems: TaskWithDetails = {
            ...snapshotTasks[0],
            items: snapshotTasks.flatMap((task) => task.items),
        };

        const [prepItems, billOfMaterials] = await Promise.all([
            this._getPrepItemsForTask(tenantId, combinedTaskItems), // 同步函数
            this._getBillOfMaterialsForDateInternal(tenantId, snapshotTasks),
        ]);

        const detailsParts: string[] = [];
        if (billOfMaterials.standardItems.length > 0 || billOfMaterials.nonInventoriedItems.length > 0) {
            detailsParts.push('备料清单');
        }
        if (prepItems.length > 0) {
            detailsParts.push(`${prepItems.length}种预制件`);
        }

        if (detailsParts.length === 0) {
            return null;
        }

        return {
            id: 'prep-task-combined',
            title: '前置准备任务',
            details: detailsParts.join('，'),
        };
    }

    async getPrepTaskDetails(tenantId: string, date?: string): Promise<PrepTask | null> {
        const summary = await this._getPrepTaskSummary(tenantId, date);
        if (!summary) {
            return null;
        }

        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const tasksStartingToday = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
                items: {
                    some: {
                        product: { deletedAt: null },
                    },
                },
                recipeSnapshot: { not: Prisma.JsonNull },
            },
            select: {
                recipeSnapshot: true,
            },
        });

        if (tasksStartingToday.length === 0) {
            return null;
        }

        const snapshotTasks = tasksStartingToday
            .map((task) => {
                if (!task.recipeSnapshot) return null;
                return task.recipeSnapshot as unknown as TaskWithDetails;
            })
            .filter((t): t is TaskWithDetails => t !== null);

        if (snapshotTasks.length === 0) {
            return null;
        }

        const combinedTaskItems: TaskWithDetails = {
            ...snapshotTasks[0],
            items: snapshotTasks.flatMap((task) => task.items),
        };

        const [prepItems, billOfMaterials] = await Promise.all([
            this._getPrepItemsForTask(tenantId, combinedTaskItems), // 同步函数
            this._getBillOfMaterialsForDateInternal(tenantId, snapshotTasks),
        ]);

        return {
            ...summary,
            items: prepItems,
            billOfMaterials,
        };
    }

    async findActive(tenantId: string, date?: string) {
        const [tasksForDate, dateStats] = await Promise.all([
            this.findTasksForDate(tenantId, date),
            this.getPendingStatsForDate(tenantId, date),
        ]);

        const prepTaskSummary = await this._getPrepTaskSummary(tenantId, date);

        const inProgressTasks = tasksForDate.filter((task) => task.status === 'IN_PROGRESS');
        const pendingTasks = tasksForDate.filter((task) => task.status === 'PENDING');

        inProgressTasks.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        pendingTasks.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

        const sortedRegularTasks = [...inProgressTasks, ...pendingTasks];

        const combinedTasks: (
            | (ProductionTask & { items: { product: { name: string }; quantity: number }[] })
            | (Omit<PrepTask, 'items' | 'billOfMaterials'> & { status: 'PREP' })
        )[] = [...sortedRegularTasks];

        if (prepTaskSummary) {
            combinedTasks.unshift({ ...prepTaskSummary, status: 'PREP' });
        }

        return {
            stats: dateStats,
            tasks: combinedTasks,
            prepTask: null,
        };
    }

    private async findTasksForDate(tenantId: string, date?: string) {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
            status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
            startDate: {
                lte: endOfDay,
            },
            OR: [
                {
                    endDate: {
                        gte: startOfDay,
                    },
                },
                {
                    endDate: null,
                },
            ],
            items: {
                some: {
                    product: { deletedAt: null },
                },
            },
        };

        return this.prisma.productionTask.findMany({
            where,
            include: taskListItemsInclude,
            orderBy: {
                startDate: 'asc',
            },
        });
    }

    private async getPendingStatsForDate(tenantId: string, date?: string) {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
        const endOfDay = new Date(
            targetDate.getFullYear(),
            targetDate.getMonth(),
            targetDate.getDate(),
            23,
            59,
            59,
            999,
        );

        const pendingTasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                deletedAt: null,
                startDate: {
                    lte: endOfDay,
                },
                OR: [
                    {
                        endDate: {
                            gte: startOfDay,
                        },
                    },
                    {
                        endDate: null,
                    },
                ],
                items: {
                    some: {
                        product: { deletedAt: null },
                    },
                },
            },
            // [核心修改] 深度嵌套 include 以获取品类
            include: {
                items: {
                    include: {
                        product: {
                            select: {
                                recipeVersion: {
                                    select: {
                                        family: {
                                            select: {
                                                category: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        // [核心修改] 统计逻辑：如果是 OTHER (自制原料)，计数 +1，否则 +quantity
        const pendingCount = pendingTasks.reduce((sum, task) => {
            return (
                sum +
                task.items.reduce((itemSum, item) => {
                    const category = item.product?.recipeVersion?.family?.category;
                    if (category === RecipeCategory.OTHER) {
                        return itemSum + 1; // 自制原料任务只算1个单位
                    }
                    return itemSum + item.quantity; // 普通产品任务算具体数量
                }, 0)
            );
        }, 0);

        return {
            pendingCount: pendingCount,
        };
    }

    async getTaskDates(tenantId: string) {
        const tasks = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: {
                    in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS],
                },
                items: {
                    some: {
                        product: { deletedAt: null },
                    },
                },
            },
            select: {
                startDate: true,
                endDate: true,
            },
        });

        const dates = new Set<string>();
        tasks.forEach((task) => {
            const current = new Date(task.startDate);
            const end = task.endDate ? new Date(task.endDate) : new Date(task.startDate);

            current.setUTCHours(0, 0, 0, 0);
            end.setUTCHours(0, 0, 0, 0);

            while (current <= end) {
                dates.add(current.toISOString().split('T')[0]);
                current.setDate(current.getDate() + 1);
            }
        });

        return Array.from(dates);
    }

    getSpoilageStages() {
        return spoilageStages;
    }

    async findHistory(tenantId: string, query: QueryProductionTaskDto) {
        const { page, limit = '10' } = query;
        const pageNum = parseInt(page || '1', 10);
        const limitNum = parseInt(limit, 10);

        const where: Prisma.ProductionTaskWhereInput = {
            tenantId,
            deletedAt: null,
            status: { in: [ProductionTaskStatus.COMPLETED, ProductionTaskStatus.CANCELLED] },
        };

        const tasks = await this.prisma.productionTask.findMany({
            where,
            include: taskListItemsInclude,
            orderBy: {
                updatedAt: 'desc',
            },
            skip: (pageNum - 1) * limitNum,
            take: limitNum,
        });

        const groupedTasks = tasks.reduce((acc: Record<string, typeof tasks>, task) => {
            const date = new Date(task.updatedAt).toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'long',
            });
            if (!acc[date]) {
                acc[date] = [];
            }
            acc[date].push(task);
            return acc;
        }, {});

        const totalTasks = await this.prisma.productionTask.count({ where });

        return {
            data: groupedTasks,
            meta: {
                total: totalTasks,
                page: pageNum,
                limit: limitNum,
                lastPage: Math.ceil(totalTasks / limitNum),
                hasMore: pageNum * limitNum < totalTasks,
            },
        };
    }

    /**
     * 此方法基于传入的“产品详情”（来自快照或实时）计算BOM
     */
    private _getFlattenedIngredientsForBOM(product: ProductWithDetails): Map<string, Prisma.Decimal> {
        const flattenedIngredients = new Map<string, Prisma.Decimal>();
        if (!product.recipeVersion || product.deletedAt) {
            return flattenedIngredients;
        }

        const mainComponent = product.recipeVersion.components[0];
        if (!mainComponent) return flattenedIngredients;

        const baseDoughWeight = new Prisma.Decimal(product.baseDoughWeight);
        const divisionLoss = new Prisma.Decimal(mainComponent.divisionLoss || 0);
        const divisionLossFactor = baseDoughWeight.isZero()
            ? new Prisma.Decimal(1)
            : baseDoughWeight.add(divisionLoss).div(baseDoughWeight);

        // 强类型
        const processComponentWithLoss = (
            component: ComponentWithIngredients,
            requiredOutputWeight: Prisma.Decimal,
        ) => {
            const lossRatio = new Prisma.Decimal(component.lossRatio || 0);
            const divisor = new Prisma.Decimal(1).sub(lossRatio);
            if (divisor.isZero() || divisor.isNegative()) return;
            const totalInputWeight = requiredOutputWeight.div(divisor);

            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );
            if (totalRatio.isZero()) return;

            const weightPerRatioPoint = totalInputWeight.div(totalRatio);

            for (const ing of component.ingredients) {
                const ingredientInputWeight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));
                if (ing.linkedPreDough) {
                    const preDoughComponent = ing.linkedPreDough.versions?.[0]?.components?.[0];
                    if (preDoughComponent) {
                        processComponentWithLoss(preDoughComponent as ComponentWithIngredients, ingredientInputWeight);
                    }
                } else if (ing.linkedExtra) {
                    // BOM 计算必须包含 ComponentIngredient.linkedExtra
                    const extraComponent = ing.linkedExtra.versions?.[0]?.components?.[0];
                    if (extraComponent) {
                        processComponentWithLoss(extraComponent as ComponentWithIngredients, ingredientInputWeight);
                    }
                } else if (ing.ingredientId) {
                    const currentWeight = flattenedIngredients.get(ing.ingredientId) || new Prisma.Decimal(0);
                    flattenedIngredients.set(ing.ingredientId, currentWeight.add(ingredientInputWeight));
                }
            }
        };

        const theoreticalFlourWeightPerUnit = this._calculateTheoreticalTotalFlourWeightForProduct(product);

        const mainDoughLossDivisor = new Prisma.Decimal(1).sub(mainComponent.lossRatio || 0);
        if (mainDoughLossDivisor.isZero() || mainDoughLossDivisor.isNegative()) return flattenedIngredients;

        for (const ing of mainComponent.ingredients) {
            let theoreticalWeight: Prisma.Decimal;
            if (ing.linkedPreDough && ing.flourRatio) {
                const preDoughRecipe = ing.linkedPreDough.versions[0]?.components[0];
                if (!preDoughRecipe) continue;
                const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                    (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                    new Prisma.Decimal(0),
                );
                theoreticalWeight = theoreticalFlourWeightPerUnit
                    .mul(new Prisma.Decimal(ing.flourRatio))
                    .mul(preDoughTotalRatio);
            } else if (ing.ingredient && ing.ratio) {
                theoreticalWeight = theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(ing.ratio));
            } else if (ing.linkedExtra && ing.ratio) {
                // BOM 计算必须包含 ComponentIngredient.linkedExtra
                // 它的 theoreticalWeight 就是按 ratio 算的
                theoreticalWeight = theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(ing.ratio));
            } else {
                continue;
            }

            const requiredOutputWeight = theoreticalWeight.mul(divisionLossFactor).div(mainDoughLossDivisor);

            if (ing.linkedPreDough) {
                const preDoughComponent = ing.linkedPreDough.versions?.[0]?.components?.[0];
                if (preDoughComponent) {
                    processComponentWithLoss(preDoughComponent as ComponentWithIngredients, requiredOutputWeight);
                }
            } else if (ing.linkedExtra) {
                // BOM 计算必须包含 ComponentIngredient.linkedExtra
                const extraComponent = ing.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    processComponentWithLoss(extraComponent as ComponentWithIngredients, requiredOutputWeight);
                }
            } else if (ing.ingredientId) {
                const currentWeight = flattenedIngredients.get(ing.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(ing.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

        for (const pIng of product.ingredients || []) {
            let theoreticalWeight = new Prisma.Decimal(0);
            if (pIng.weightInGrams) {
                theoreticalWeight = new Prisma.Decimal(pIng.weightInGrams);
            } else if (pIng.ratio && pIng.type === 'MIX_IN') {
                theoreticalWeight = theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(pIng.ratio));
            } else {
                continue;
            }

            let requiredOutputWeight = theoreticalWeight;
            if (pIng.type === 'MIX_IN') {
                requiredOutputWeight = theoreticalWeight.mul(divisionLossFactor).div(mainDoughLossDivisor);
            }

            if (pIng.linkedExtra) {
                const extraComponent = pIng.linkedExtra.versions?.[0]?.components?.[0];
                if (extraComponent) {
                    processComponentWithLoss(extraComponent as ComponentWithIngredients, requiredOutputWeight);
                }
            } else if (pIng.ingredientId) {
                const currentWeight = flattenedIngredients.get(pIng.ingredientId) || new Prisma.Decimal(0);
                flattenedIngredients.set(pIng.ingredientId, currentWeight.add(requiredOutputWeight));
            }
        }

        return flattenedIngredients;
    }

    /**
     * 此方法现在基于“快照”列表计算BOM
     */
    private async _calculateBillOfMaterialsForTasks(
        tenantId: string,
        tasks: TaskWithDetails[],
    ): Promise<BillOfMaterialsResponseDto> {
        const totalConsumptionMap = new Map<string, Prisma.Decimal>();

        for (const task of tasks) {
            for (const item of task.items) {
                if (item.product.deletedAt) continue;
                const consumptions = this._getFlattenedIngredientsForBOM(item.product);

                for (const [ingredientId, weight] of consumptions.entries()) {
                    const totalRequiredForItem = weight.mul(item.quantity);
                    const existing = totalConsumptionMap.get(ingredientId) || new Prisma.Decimal(0);
                    totalConsumptionMap.set(ingredientId, existing.add(totalRequiredForItem));
                }
            }
        }

        const ingredientIds = Array.from(totalConsumptionMap.keys());
        if (ingredientIds.length === 0) {
            return { standardItems: [], nonInventoriedItems: [] };
        }

        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                id: { in: ingredientIds },
            },
            select: {
                id: true,
                name: true,
                type: true,
                currentStockInGrams: true,
                activeSku: {
                    select: {
                        brand: true,
                    },
                },
            },
        });

        const standardItems: BillOfMaterialsItem[] = [];
        const nonInventoriedItems: BillOfMaterialsItem[] = [];

        for (const ingredient of ingredients) {
            const requiredDecimal = totalConsumptionMap.get(ingredient.id);
            if (!requiredDecimal) continue;
            const required = requiredDecimal.toNumber();
            const brand = ingredient.activeSku?.brand || null;

            if (ingredient.type === IngredientType.STANDARD) {
                const currentStock = ingredient.currentStockInGrams.toNumber();

                standardItems.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    brand,
                    currentStock,
                    totalRequired: required,
                });
            } else if (ingredient.type === IngredientType.NON_INVENTORIED) {
                nonInventoriedItems.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    brand,
                    totalRequired: required,
                });
            }
        }

        standardItems.sort((a, b) => b.totalRequired - a.totalRequired);
        nonInventoriedItems.sort((a, b) => b.totalRequired - a.totalRequired);

        return { standardItems, nonInventoriedItems };
    }

    /**
     * 这是一个新的内部函数，它接收解析后的快照列表
     */
    private async _getBillOfMaterialsForDateInternal(
        tenantId: string,
        snapshotTasks: TaskWithDetails[],
    ): Promise<BillOfMaterialsResponseDto> {
        if (snapshotTasks.length === 0) {
            return { standardItems: [], nonInventoriedItems: [] };
        }

        return this._calculateBillOfMaterialsForTasks(tenantId, snapshotTasks);
    }

    async getBillOfMaterialsForDate(tenantId: string, date?: string): Promise<BillOfMaterialsResponseDto> {
        let targetDate: Date;
        if (date) {
            targetDate = new Date(date);
            if (isNaN(targetDate.getTime())) {
                targetDate = new Date();
            }
        } else {
            targetDate = new Date();
        }

        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const tasksStartingToday = await this.prisma.productionTask.findMany({
            where: {
                tenantId,
                deletedAt: null,
                status: { in: [ProductionTaskStatus.PENDING, ProductionTaskStatus.IN_PROGRESS] },
                startDate: {
                    gte: startOfDay,
                    lte: endOfDay,
                },
                items: {
                    some: {
                        product: { deletedAt: null },
                    },
                },
                recipeSnapshot: { not: Prisma.JsonNull },
            },
            select: {
                recipeSnapshot: true,
            },
        });

        if (tasksStartingToday.length === 0) {
            return { standardItems: [], nonInventoriedItems: [] };
        }

        const snapshotTasks = tasksStartingToday
            .map((task) => {
                if (!task.recipeSnapshot) return null;
                return task.recipeSnapshot as unknown as TaskWithDetails;
            })
            .filter((t): t is TaskWithDetails => t !== null);

        return this._getBillOfMaterialsForDateInternal(tenantId, snapshotTasks);
    }

    async findOne(tenantId: string, id: string, query: QueryTaskDetailDto): Promise<TaskDetailResponseDto> {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: {
                id: true,
                status: true,
                notes: true,
                items: {
                    select: {
                        quantity: true,
                        product: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                recipeSnapshot: true,
            },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        if (!task.recipeSnapshot) {
            try {
                task.recipeSnapshot = await this._fetchAndSerializeSnapshot(id);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                throw new NotFoundException(`生产任务数据不完整或快照丢失: ${message}`);
            }
        }

        // 任务数据源*始终*是快照
        const taskDataForCalc = task.recipeSnapshot as unknown as TaskWithDetails;

        const componentGroups = this._calculateComponentGroups(taskDataForCalc, query, task.items);
        const { stockWarning } = await this._calculateStockWarning(tenantId, taskDataForCalc);

        return {
            id: task.id,
            status: task.status,
            notes: task.notes,
            stockWarning,
            componentGroups,
            items: task.items.map((item) => ({
                id: item.product.id,
                name: item.product.name,
                plannedQuantity: item.quantity,
            })),
        };
    }

    private _parseAndCalculateProcedureNotes(
        procedure: string[] | undefined | null,
        baseForPercentageCalc: Prisma.Decimal,
    ): { processedProcedure: string[]; ingredientNotes: Map<string, string> } {
        if (!procedure) {
            return { processedProcedure: [], ingredientNotes: new Map() };
        }

        const tempNotes = new Map<string, string[]>();
        const percentageRegex = /\[(\d+(?:\.\d+)?)%\]/g;
        const noteRegex = /@([^（(]+?)\s*?[（(]([^)）]+?)[)）]/g;

        const processedProcedure = procedure
            .map((step) => {
                let currentStep = step;
                if (!baseForPercentageCalc.isZero()) {
                    currentStep = step.replace(percentageRegex, (match: string, p1: string) => {
                        const percentage = new Prisma.Decimal(p1);
                        const calculatedWeight = baseForPercentageCalc.mul(percentage.div(100));
                        return `${calculatedWeight.toDP(2).toNumber()}克`;
                    });
                }

                const noteMatches = [...currentStep.matchAll(noteRegex)];
                for (const noteMatch of noteMatches) {
                    const ingredientName = noteMatch[1].trim();
                    const content = noteMatch[2].trim();
                    if (!tempNotes.has(ingredientName)) {
                        tempNotes.set(ingredientName, []);
                    }
                    tempNotes.get(ingredientName)!.push(content);
                }

                const cleanedStep = currentStep.replace(noteRegex, '').trim();

                if (cleanedStep === '') {
                    return null;
                }
                return cleanedStep;
            })
            .filter((step): step is string => step !== null);

        const ingredientNotes = new Map<string, string>();
        tempNotes.forEach((notes, name) => {
            ingredientNotes.set(name, notes.join(' '));
        });

        return { processedProcedure, ingredientNotes };
    }

    private _parseProcedureForNotes(
        procedure: string[] | undefined | null,
        ingredientNotes: Map<string, string>,
    ): { cleanedProcedure: string[]; ingredientNotes: Map<string, string> } {
        if (!procedure) {
            return { cleanedProcedure: [], ingredientNotes };
        }
        const noteRegex = /@(?:\[)?(.*?)(?:\])?[(（](.*?)[)）]/g;

        const cleanedProcedure = procedure
            .map((step) => {
                const stepMatches = [...step.matchAll(noteRegex)];
                for (const match of stepMatches) {
                    const [, ingredientName, note] = match;
                    if (ingredientName && note) {
                        ingredientNotes.set(ingredientName.trim(), note.trim());
                    }
                }

                const cleanedStep = step.replace(noteRegex, '').trim();

                if (cleanedStep === '') {
                    return null;
                }

                return cleanedStep;
            })
            .filter((step): step is string => step !== null);

        return { cleanedProcedure, ingredientNotes };
    }

    /**
     * 此方法现在基于“快照”计算
     */
    private _calculateComponentGroups(
        task: TaskWithDetails,
        query: QueryTaskDetailDto,
        originalItems: { quantity: number; product: { id: string } }[],
    ): ComponentGroup[] {
        const { mixerType, envTemp, flourTemp, waterTemp } = query;
        const canCalculateIce =
            mixerType !== undefined && envTemp !== undefined && flourTemp !== undefined && waterTemp !== undefined;

        const originalItemsMap = new Map(originalItems.map((item) => [item.product.id, item]));

        const componentsMap = new Map<
            string,
            { familyName: string; category: RecipeCategory; type: RecipeType; items: TaskItemWithDetails[] }
        >();
        task.items.forEach((item) => {
            if (item.product.deletedAt) return;
            const family = item.product.recipeVersion.family;
            if (!componentsMap.has(family.id)) {
                componentsMap.set(family.id, {
                    familyName: family.name,
                    category: family.category,
                    type: family.type,
                    items: [],
                });
            }
            componentsMap.get(family.id)!.items.push(item);
        });

        const componentGroups: ComponentGroup[] = [];
        for (const [familyId, data] of componentsMap.entries()) {
            const firstItem = data.items[0];

            const versionNotes = (firstItem.product.recipeVersion as unknown as { notes: string | null }).notes;

            const baseComponentInfo = firstItem.product.recipeVersion.components[0];

            let totalFlourForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                // 从 originalItemsMap 获取“计划数量”
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                // _calculateTotalFlourWeightForProduct 基于“快照”中的 product 计算
                const flourPerUnit = this._calculateTotalFlourWeightForProduct(item.product);
                totalFlourForFamily = totalFlourForFamily.add(flourPerUnit.mul(quantity));
            }

            const { processedProcedure, ingredientNotes } = this._parseAndCalculateProcedureNotes(
                baseComponentInfo.procedure,
                totalFlourForFamily,
            );

            const baseComponentIngredientsMap = new Map<string, SortableTaskIngredient>();
            let totalComponentWeight = new Prisma.Decimal(0);

            let totalWaterForFamily = new Prisma.Decimal(0);
            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                // _calculateTotalWaterWeightForProduct 基于“快照”中的 product 计算
                const waterPerUnit = this._calculateTotalWaterWeightForProduct(item.product);
                totalWaterForFamily = totalWaterForFamily.add(waterPerUnit.mul(quantity));
            }

            let waterIngredientId: string | null = null;
            for (const ing of baseComponentInfo.ingredients) {
                if (ing.ingredient?.name === '水') {
                    waterIngredientId = ing.ingredient.id;
                    break;
                }
            }

            for (const item of data.items) {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                const totalFlour = this._calculateTotalFlourWeightForProduct(item.product);
                for (const ing of baseComponentInfo.ingredients) {
                    let weight: Prisma.Decimal;
                    let id: string;
                    let name: string;
                    let brand: string | null = null;
                    let isRecipe = false;
                    let isFlour = false;

                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions[0]?.components[0];
                        if (!preDoughRecipe) continue;

                        const preDoughTotalRatio = preDoughRecipe.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        weight = totalFlour.mul(new Prisma.Decimal(ing.flourRatio)).mul(preDoughTotalRatio);
                        id = ing.linkedPreDough.id;
                        name = ing.linkedPreDough.name;
                        isRecipe = true;
                        brand = '自制面种';
                    } else if (ing.ingredient && ing.ratio) {
                        weight = totalFlour.mul(new Prisma.Decimal(ing.ratio));
                        id = ing.ingredient.id;
                        name = ing.ingredient.name;
                        brand = ing.ingredient.activeSku?.brand || null;
                        isFlour = ing.ingredient.isFlour;
                    } else if (ing.linkedExtra && ing.ratio) {
                        // 计算 ComponentIngredient.linkedExtra
                        // 它的算法和标准原料一样，都是 (面粉基准 * 比例)
                        weight = totalFlour.mul(new Prisma.Decimal(ing.ratio));
                        id = ing.linkedExtra.id;
                        name = ing.linkedExtra.name;
                        isRecipe = true;
                        brand = '自制原料';
                    } else {
                        continue;
                    }

                    const currentTotalWeight = weight.mul(quantity);
                    totalComponentWeight = totalComponentWeight.add(currentTotalWeight);

                    const existing = baseComponentIngredientsMap.get(id);
                    if (existing) {
                        existing.weightInGrams += currentTotalWeight.toNumber();
                    } else {
                        // 明确类型为 SortableTaskIngredient
                        const newIngredient: SortableTaskIngredient = {
                            id,
                            name,
                            brand,
                            weightInGrams: currentTotalWeight.toNumber(),
                            isRecipe,
                            isFlour,
                            extraInfo: ingredientNotes.get(name) || null,
                        };
                        baseComponentIngredientsMap.set(id, newIngredient);
                    }
                }
            }

            if (canCalculateIce && baseComponentInfo.targetTemp && waterIngredientId) {
                const waterIngredient = baseComponentIngredientsMap.get(waterIngredientId);
                // 增加 waterIngredient 的存在性检查
                if (waterIngredient && waterIngredient.weightInGrams > 0) {
                    const autoCalculatedParts: string[] = [];

                    const actualLiquidWaterWeight = waterIngredient.weightInGrams;
                    const totalMoistureWeight = totalWaterForFamily.toNumber();

                    const targetWaterTemp = this._calculateWaterTemp(
                        new Prisma.Decimal(baseComponentInfo.targetTemp).toNumber(),
                        mixerType,
                        flourTemp,
                        envTemp,
                    );

                    const iceWeight = this._calculateIce(
                        targetWaterTemp,
                        actualLiquidWaterWeight, // <-- 使用“实际液态水”重量
                        waterTemp,
                    );

                    if (iceWeight > actualLiquidWaterWeight) {
                        // 场景 3：所需冰量 > 可用液态水
                        // 触发反向计算，提示冷却其他液体

                        const requiredTemp = this._calculateRequiredWetIngredientTemp(
                            targetWaterTemp,
                            totalMoistureWeight, // <-- 使用“总水分”
                            actualLiquidWaterWeight, // <-- 使用“实际液态水”
                        );
                        autoCalculatedParts.push(
                            `需将所有水 (${new Prisma.Decimal(actualLiquidWaterWeight).toDP(0).toNumber()}g) 换成冰块，且其他液体原料需冷却至 ${new Prisma.Decimal(
                                requiredTemp,
                            )
                                .toDP(1)
                                .toNumber()}°C`,
                        );
                    } else if (iceWeight > 0) {
                        // 正常提示换冰
                        autoCalculatedParts.push(`需要替换 ${new Prisma.Decimal(iceWeight).toDP(1).toNumber()}g 冰`);
                    }

                    const finalInfoParts: string[] = [];
                    if (autoCalculatedParts.length > 0) {
                        finalInfoParts.push(...autoCalculatedParts);
                    }

                    if (waterIngredient.extraInfo) {
                        finalInfoParts.push(waterIngredient.extraInfo);
                    }

                    if (finalInfoParts.length > 0) {
                        waterIngredient.extraInfo = finalInfoParts.join('\n');
                    }
                }
            }

            const productDetails: ProductDetails[] = [];
            const baseComponentName = data.category === 'BREAD' ? '面团' : '主料';

            data.items.forEach((item) => {
                const originalItem = originalItemsMap.get(item.productId);
                const quantity = originalItem?.quantity ?? 0;
                if (quantity === 0) return;

                const { product } = item;

                const flourWeightPerUnitWithLoss = this._calculateTotalFlourWeightForProduct(product);

                const flattenedProductIngredients = this._flattenIngredientsForProduct(product, false);

                const mixIns: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: flourWeightPerUnitWithLoss.mul(new Prisma.Decimal(ing.ratio ?? 0)).toNumber(),
                        extraInfo: null,
                    }))
                    .sort((a, b) => b.weightInGrams - a.weightInGrams);

                const fillings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'FILLING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: new Prisma.Decimal(ing.weightInGrams ?? 0).toNumber(),
                        extraInfo: null,
                    }))
                    .sort((a, b) => b.weightInGrams - a.weightInGrams);

                const toppings: TaskIngredientDetail[] = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'TOPPING')
                    .map((ing) => ({
                        id: ing.id,
                        name: ing.name,
                        brand: ing.isRecipe ? '自制原料' : ing.brand,
                        isRecipe: ing.isRecipe,
                        weightInGrams: new Prisma.Decimal(ing.weightInGrams ?? 0).toNumber(),
                        extraInfo: null,
                    }))
                    .sort((a, b) => b.weightInGrams - a.weightInGrams);

                const theoreticalFlourWeightPerUnit = this._calculateTheoreticalTotalFlourWeightForProduct(product);
                const theoreticalMixInWeightPerUnit = Array.from(flattenedProductIngredients.values())
                    .filter((ing) => ing.type === 'MIX_IN')
                    .reduce(
                        (sum, ing) => sum.add(theoreticalFlourWeightPerUnit.mul(new Prisma.Decimal(ing.ratio ?? 0))),
                        new Prisma.Decimal(0),
                    );

                const correctedDivisionWeight = new Prisma.Decimal(product.baseDoughWeight).add(
                    theoreticalMixInWeightPerUnit,
                );

                const lossRatio = new Prisma.Decimal(baseComponentInfo.lossRatio || 0);
                const divisor = new Prisma.Decimal(1).sub(lossRatio);

                const divisionLoss = new Prisma.Decimal(baseComponentInfo.divisionLoss || 0);

                const targetBaseDoughWeight = new Prisma.Decimal(product.baseDoughWeight).add(divisionLoss);

                const singleUnitInputWeight =
                    divisor.isZero() || divisor.isNegative()
                        ? targetBaseDoughWeight
                        : targetBaseDoughWeight.div(divisor);

                const totalBaseComponentWeightWithLoss = singleUnitInputWeight.mul(quantity);

                productDetails.push({
                    id: product.id,
                    name: product.name,
                    baseComponent: {
                        name: baseComponentName, // 使用前面定义的名称
                        quantity: quantity,
                        totalBaseComponentWeight: totalBaseComponentWeightWithLoss.toNumber(),
                        divisionWeight: correctedDivisionWeight.toNumber(),
                    },
                    mixIns: mixIns.map((i) => ({ ...i, weightInGrams: i.weightInGrams * quantity })),
                    fillings: fillings.map((i) => ({
                        ...i,
                        weightPerUnit: i.weightInGrams,
                        weightInGrams: i.weightInGrams * quantity,
                    })),
                    toppings: toppings.map((i) => ({
                        ...i,
                        weightPerUnit: i.weightInGrams,
                        weightInGrams: i.weightInGrams * quantity,
                    })),
                    procedure: product.procedure || [],
                });
            });

            componentGroups.push({
                familyId,
                familyName: data.familyName,
                note: versionNotes,
                category: data.category,
                productsDescription: data.items
                    .map((i: TaskItemWithDetails) => {
                        const originalItem = originalItemsMap.get(i.productId);
                        const quantity = originalItem?.quantity ?? 0;
                        return `${i.product.name} x${quantity}`;
                    })
                    .join(', '),
                totalComponentWeight: totalComponentWeight.toNumber(),
                baseComponentIngredients: this._sortTaskIngredients(
                    Array.from(baseComponentIngredientsMap.values()),
                    data.category,
                    data.type,
                ),
                baseComponentProcedure: processedProcedure,
                productDetails,
            });
        }
        return componentGroups;
    }

    /**
     * 此方法现在基于“快照”中的 product 对象计算
     */
    private _flattenIngredientsForProduct(
        product: ProductWithDetails,
        includeDough = true,
    ): Map<string, FlattenedIngredient> {
        const flattened = new Map<string, FlattenedIngredient>();
        if (!product.recipeVersion || product.deletedAt) {
            return flattened;
        }

        const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);

        if (includeDough) {
            // 强类型
            const processDough = (dough: ComponentWithRecursiveIngredients, flourWeightRef: Prisma.Decimal) => {
                for (const ing of dough.ingredients) {
                    if (ing.linkedPreDough && ing.flourRatio) {
                        const preDoughRecipe = ing.linkedPreDough.versions[0]?.components[0];
                        if (preDoughRecipe) {
                            const flourForPreDough = flourWeightRef.mul(new Prisma.Decimal(ing.flourRatio));
                            processDough(preDoughRecipe as ComponentWithRecursiveIngredients, flourForPreDough);
                        }
                    } else if (ing.ingredient && ing.ratio) {
                        const weight = flourWeightRef.mul(new Prisma.Decimal(ing.ratio ?? 0));

                        const existing = flattened.get(ing.ingredient.id);
                        if (existing) {
                            existing.weight = existing.weight.add(weight);
                        } else {
                            flattened.set(ing.ingredient.id, {
                                id: ing.ingredient.id,
                                name: ing.ingredient.name,
                                weight: weight,
                                brand: ing.ingredient.activeSku?.brand || null,
                                isRecipe: false,
                                waterContent: new Prisma.Decimal(ing.ingredient.waterContent),
                            });
                        }
                    } else if (ing.linkedExtra && ing.ratio) {
                        // 递归展开 ComponentIngredient.linkedExtra
                        const extraRecipe = ing.linkedExtra.versions[0]?.components[0];
                        if (extraRecipe) {
                            // 修正逻辑：Extra 配方不使用面粉基准
                            // 我们需要计算这个 Extra 配方的总重
                            const extraWeight = flourWeightRef.mul(new Prisma.Decimal(ing.ratio ?? 0));
                            // Extra 配方内部使用 ratio
                            this._flattenExtraRecipe(
                                extraRecipe as ComponentWithRecursiveIngredients,
                                extraWeight,
                                flattened,
                            );
                        }
                    }
                }
            };
            processDough(product.recipeVersion.components[0], totalFlourWeight);
        }

        for (const pIng of product.ingredients) {
            if (pIng.ingredient) {
                const uniqueKey = `${pIng.ingredient.id}-${pIng.type}`;
                flattened.set(uniqueKey, {
                    id: pIng.ingredient.id,
                    name: pIng.ingredient.name,
                    weight: new Prisma.Decimal(0),
                    brand: pIng.ingredient.activeSku?.brand || null,
                    isRecipe: false,
                    type: pIng.type,
                    ratio: pIng.ratio ? new Prisma.Decimal(pIng.ratio) : undefined,
                    weightInGrams: pIng.weightInGrams ? new Prisma.Decimal(pIng.weightInGrams) : undefined,
                    waterContent: new Prisma.Decimal(pIng.ingredient.waterContent),
                });
            } else if (pIng.linkedExtra) {
                const uniqueKey = `${pIng.linkedExtra.id}-${pIng.type}`;
                flattened.set(uniqueKey, {
                    id: pIng.linkedExtra.id,
                    name: pIng.linkedExtra.name,
                    weight: new Prisma.Decimal(0),
                    brand: null,
                    isRecipe: true,
                    recipeType: pIng.linkedExtra.type,
                    recipeFamily: pIng.linkedExtra,
                    type: pIng.type,
                    ratio: pIng.ratio ? new Prisma.Decimal(pIng.ratio) : undefined,
                    weightInGrams: pIng.weightInGrams ? new Prisma.Decimal(pIng.weightInGrams) : undefined,
                });
            }
        }

        return flattened;
    }

    // _flattenIngredientsForProduct 的辅助函数，用于展开 EXTRA 配方
    private _flattenExtraRecipe(
        dough: ComponentWithRecursiveIngredients,
        totalWeight: Prisma.Decimal,
        flattened: Map<string, FlattenedIngredient>,
    ) {
        const totalRatio = dough.ingredients.reduce(
            (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
            new Prisma.Decimal(0),
        );
        if (totalRatio.isZero()) return;

        const weightPerRatioPoint = totalWeight.div(totalRatio);

        for (const ing of dough.ingredients) {
            const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

            if (ing.ingredient && ing.ratio) {
                const existing = flattened.get(ing.ingredient.id);
                if (existing) {
                    existing.weight = existing.weight.add(weight);
                } else {
                    flattened.set(ing.ingredient.id, {
                        id: ing.ingredient.id,
                        name: ing.ingredient.name,
                        weight: weight,
                        brand: ing.ingredient.activeSku?.brand || null,
                        isRecipe: false,
                        waterContent: new Prisma.Decimal(ing.ingredient.waterContent),
                    });
                }
            } else if (ing.linkedExtra && ing.ratio) {
                // 递归调用
                const extraRecipe = ing.linkedExtra.versions[0]?.components[0];
                if (extraRecipe) {
                    this._flattenExtraRecipe(extraRecipe as ComponentWithRecursiveIngredients, weight, flattened);
                }
            }
        }
    }

    /**
     * 此方法现在基于“快照”中的 product 对象计算
     */
    private _calculateTheoreticalTotalFlourWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        if (!product.recipeVersion || product.deletedAt) {
            return new Prisma.Decimal(0);
        }
        const mainDough = product.recipeVersion.components[0];
        if (!mainDough) return new Prisma.Decimal(0);

        const theoreticalDoughWeight = new Prisma.Decimal(product.baseDoughWeight);

        // 强类型
        const calculateTotalRatio = (dough: ComponentWithRecursiveIngredients): Prisma.Decimal => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions[0]?.components[0];
                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        return sum.add(new Prisma.Decimal(i.flourRatio).mul(preDoughTotalRatio));
                    }
                } else if (i.linkedExtra && i.ratio) {
                    // 理论重量计算必须包含 ComponentIngredient.linkedExtra
                    return sum.add(new Prisma.Decimal(i.ratio));
                }
                return sum.add(new Prisma.Decimal(i.ratio ?? 0));
            }, new Prisma.Decimal(0));
        };

        const totalRatio = calculateTotalRatio(mainDough);
        if (totalRatio.isZero()) return new Prisma.Decimal(0);

        return theoreticalDoughWeight.div(totalRatio);
    }

    /**
     * 此方法现在基于“快照”中的 product 对象计算
     */
    private _calculateTotalWaterWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        if (!product.recipeVersion || product.deletedAt) {
            return new Prisma.Decimal(0);
        }
        const totalFlourWeight = this._calculateTotalFlourWeightForProduct(product);
        let totalWaterWeight = new Prisma.Decimal(0);

        // 强类型
        const findWaterRecursively = (component: ComponentWithRecursiveIngredients, flourRef: Prisma.Decimal) => {
            for (const ing of component.ingredients) {
                if (ing.linkedPreDough && ing.flourRatio) {
                    const preDoughComponent = ing.linkedPreDough.versions[0]?.components[0];
                    if (preDoughComponent) {
                        const flourForPreDough = flourRef.mul(new Prisma.Decimal(ing.flourRatio));
                        findWaterRecursively(preDoughComponent as ComponentWithRecursiveIngredients, flourForPreDough);
                    }
                } else if (ing.ingredient?.waterContent && ing.ratio) {
                    const waterContentDecimal = new Prisma.Decimal(ing.ingredient.waterContent);
                    if (waterContentDecimal.gt(0)) {
                        const ratioDecimal = new Prisma.Decimal(ing.ratio);
                        const waterWeight = flourRef.mul(ratioDecimal).mul(waterContentDecimal);
                        totalWaterWeight = totalWaterWeight.add(waterWeight);
                    }
                } else if (ing.linkedExtra && ing.ratio) {
                    // 水量计算必须包含 ComponentIngredient.linkedExtra
                    const extraComponent = ing.linkedExtra.versions[0]?.components[0];
                    if (extraComponent) {
                        // EXTRA 配方不使用面粉基准，计算其总重
                        const extraWeight = flourRef.mul(new Prisma.Decimal(ing.ratio));
                        // 递归查找 EXTRA 配方中的水
                        findWaterInExtraRecipe(extraComponent as ComponentWithRecursiveIngredients, extraWeight);
                    }
                }
            }
        };

        // _calculateTotalWaterWeightForProduct 的辅助函数
        const findWaterInExtraRecipe = (component: ComponentWithRecursiveIngredients, totalWeight: Prisma.Decimal) => {
            const totalRatio = component.ingredients.reduce(
                (sum, i) => sum.add(new Prisma.Decimal(i.ratio ?? 0)),
                new Prisma.Decimal(0),
            );
            if (totalRatio.isZero()) return;
            const weightPerRatioPoint = totalWeight.div(totalRatio);

            for (const ing of component.ingredients) {
                const weight = weightPerRatioPoint.mul(new Prisma.Decimal(ing.ratio ?? 0));

                if (ing.ingredient?.waterContent && ing.ratio) {
                    const waterContentDecimal = new Prisma.Decimal(ing.ingredient.waterContent);
                    if (waterContentDecimal.gt(0)) {
                        // 注意：这里是总重 * 水含量，不是 (面粉基准 * 比例 * 水含量)
                        const waterWeight = weight.mul(waterContentDecimal);
                        totalWaterWeight = totalWaterWeight.add(waterWeight);
                    }
                } else if (ing.linkedExtra && ing.ratio) {
                    const extraComponent = ing.linkedExtra.versions[0]?.components[0];
                    if (extraComponent) {
                        findWaterInExtraRecipe(extraComponent as ComponentWithRecursiveIngredients, weight);
                    }
                }
            }
        };

        const mainComponent = product.recipeVersion.components[0];
        if (mainComponent) {
            findWaterRecursively(mainComponent, totalFlourWeight);
        }

        return totalWaterWeight;
    }

    /**
     * 此方法现在基于“快照”中的 product 对象计算
     */
    private _calculateTotalFlourWeightForProduct(product: ProductWithDetails): Prisma.Decimal {
        if (!product.recipeVersion || product.deletedAt) {
            return new Prisma.Decimal(0);
        }
        const mainDough = product.recipeVersion.components[0];
        if (!mainDough) return new Prisma.Decimal(0);

        const lossRatio = new Prisma.Decimal(mainDough.lossRatio || 0);
        const divisor = new Prisma.Decimal(1).sub(lossRatio);
        if (divisor.isZero() || divisor.isNegative()) return new Prisma.Decimal(0);

        const divisionLoss = new Prisma.Decimal(mainDough.divisionLoss || 0);
        const targetBaseDoughWeight = new Prisma.Decimal(product.baseDoughWeight).add(divisionLoss);
        const adjustedDoughWeight = targetBaseDoughWeight.div(divisor);

        // 强类型
        const calculateTotalRatio = (dough: ComponentWithRecursiveIngredients): Prisma.Decimal => {
            return dough.ingredients.reduce((sum, i) => {
                if (i.linkedPreDough && i.flourRatio) {
                    const preDough = i.linkedPreDough.versions[0]?.components[0];
                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce(
                            (s, pi) => s.add(new Prisma.Decimal(pi.ratio ?? 0)),
                            new Prisma.Decimal(0),
                        );
                        return sum.add(new Prisma.Decimal(i.flourRatio).mul(preDoughTotalRatio));
                    }
                } else if (i.linkedExtra && i.ratio) {
                    // 总比例计算必须包含 ComponentIngredient.linkedExtra
                    return sum.add(new Prisma.Decimal(i.ratio));
                }
                return sum.add(new Prisma.Decimal(i.ratio ?? 0));
            }, new Prisma.Decimal(0));
        };

        const totalRatio = calculateTotalRatio(mainDough);
        if (totalRatio.isZero()) return new Prisma.Decimal(0);

        return adjustedDoughWeight.div(totalRatio);
    }

    /**
     * 此方法现在基于“快照”计算需求，但对比“实时”库存
     */
    private async _calculateStockWarning(tenantId: string, task: TaskWithDetails) {
        const totalIngredientsMap = new Map<string, { name: string; totalWeight: number }>();
        for (const item of task.items) {
            if (item.product.deletedAt) continue;
            const consumptions = this._getFlattenedIngredientsForBOM(item.product);
            for (const [ingredientId, weight] of consumptions.entries()) {
                const totalWeight = weight.mul(item.quantity);
                const existing = totalIngredientsMap.get(ingredientId);
                const ingInfo = this._findIngredientInSnapshot(task, ingredientId);

                if (existing) {
                    existing.totalWeight += totalWeight.toNumber();
                } else {
                    totalIngredientsMap.set(ingredientId, {
                        name: ingInfo?.name || '未知原料',
                        totalWeight: totalWeight.toNumber(),
                    });
                }
            }
        }

        let stockWarning: string | null = null;
        const ingredientIds = Array.from(totalIngredientsMap.keys());
        if (ingredientIds.length > 0) {
            const ingredients = await this.prisma.ingredient.findMany({
                where: { id: { in: ingredientIds } },
                select: { id: true, name: true, currentStockInGrams: true, type: true },
            });
            const ingredientsToCheck = ingredients.filter((ing) => ing.type === IngredientType.STANDARD);
            const ingredientStockMap = new Map(ingredientsToCheck.map((i) => [i.id, i]));
            const insufficientIngredients: string[] = [];

            for (const [ingredientId, data] of totalIngredientsMap.entries()) {
                const ingredient = ingredientStockMap.get(ingredientId);
                if (ingredient && new Prisma.Decimal(ingredient.currentStockInGrams).lt(data.totalWeight)) {
                    insufficientIngredients.push(data.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                stockWarning = `库存不足: ${insufficientIngredients.join(', ')}`;
            }
        }
        return { stockWarning };
    }

    // 辅助函数：从复杂的快照对象中查找原料信息
    private _findIngredientInSnapshot(task: TaskWithDetails, ingredientId: string): Ingredient | null {
        for (const item of task.items) {
            for (const component of item.product.recipeVersion?.components || []) {
                for (const ing of component.ingredients) {
                    if (ing.ingredient?.id === ingredientId) return ing.ingredient;
                    // 递归查找 PreDough
                    if (ing.linkedPreDough) {
                        for (const v of ing.linkedPreDough.versions) {
                            for (const c of v.components) {
                                for (const ci of c.ingredients) {
                                    if (ci.ingredient?.id === ingredientId) return ci.ingredient;
                                    if (ci.linkedPreDough) {
                                        for (const v2 of ci.linkedPreDough.versions) {
                                            for (const c2 of v2.components) {
                                                for (const ci2 of c2.ingredients) {
                                                    if (ci2.ingredient?.id === ingredientId) return ci2.ingredient;
                                                }
                                            }
                                        }
                                    }
                                    // 查找 PreDough -> Extra
                                    if (ci.linkedExtra) {
                                        for (const v2 of ci.linkedExtra.versions) {
                                            for (const c2 of v2.components) {
                                                for (const ci2 of c2.ingredients) {
                                                    if (ci2.ingredient?.id === ingredientId) return ci2.ingredient;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // 递归查找 Extra
                    if (ing.linkedExtra) {
                        for (const v of ing.linkedExtra.versions) {
                            for (const c of v.components) {
                                for (const ci of c.ingredients) {
                                    if (ci.ingredient?.id === ingredientId) return ci.ingredient;
                                    if (ci.linkedPreDough) {
                                        for (const v2 of ci.linkedPreDough.versions) {
                                            for (const c2 of v2.components) {
                                                for (const ci2 of c2.ingredients) {
                                                    if (ci2.ingredient?.id === ingredientId) return ci2.ingredient;
                                                }
                                            }
                                        }
                                    }
                                    if (ci.linkedExtra) {
                                        for (const v2 of ci.linkedExtra.versions) {
                                            for (const c2 of v2.components) {
                                                for (const ci2 of c2.ingredients) {
                                                    if (ci2.ingredient?.id === ingredientId) return ci2.ingredient;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            for (const pIng of item.product.ingredients || []) {
                if (pIng.ingredient?.id === ingredientId) return pIng.ingredient;
                // 递归查找 ProductIngredient -> Extra
                if (pIng.linkedExtra) {
                    for (const v of pIng.linkedExtra.versions) {
                        for (const c of v.components) {
                            for (const ci of c.ingredients) {
                                if (ci.ingredient?.id === ingredientId) return ci.ingredient;
                                if (ci.linkedPreDough) {
                                    for (const v2 of ci.linkedPreDough.versions) {
                                        for (const c2 of v2.components) {
                                            for (const ci2 of c2.ingredients) {
                                                if (ci2.ingredient?.id === ingredientId) return ci2.ingredient;
                                            }
                                        }
                                    }
                                }
                                if (ci.linkedExtra) {
                                    for (const v2 of ci.linkedExtra.versions) {
                                        for (const c2 of v2.components) {
                                            for (const ci2 of c2.ingredients) {
                                                if (ci2.ingredient?.id === ingredientId) return ci2.ingredient;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return null;
    }

    async updateTaskDetails(tenantId: string, id: string, updateDto: UpdateTaskDetailsDto) {
        return this.prisma.$transaction(async (tx) => {
            const task = await tx.productionTask.findFirst({
                where: {
                    id,
                    tenantId,
                    deletedAt: null,
                },
            });

            if (!task) {
                throw new NotFoundException('生产任务不存在');
            }

            if (task.status !== ProductionTaskStatus.PENDING) {
                throw new BadRequestException('只有“待开始”的任务才能被修改');
            }

            const { startDate, endDate, notes, products } = updateDto;

            if (!products || products.length === 0) {
                throw new BadRequestException('一个生产任务至少需要包含一个产品。');
            }

            await tx.productionTaskItem.deleteMany({
                where: { taskId: id },
            });

            const productIds = products.map((p) => p.productId);

            const existingProducts = await tx.product.findMany({
                where: {
                    id: { in: productIds },
                    recipeVersion: { family: { tenantId } },
                    deletedAt: null,
                },
                include: {
                    recipeVersion: {
                        include: {
                            family: {
                                select: {
                                    deletedAt: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });

            if (existingProducts.length !== productIds.length) {
                throw new NotFoundException('一个或多个目标产品不存在或不属于该店铺。');
            }

            const discontinuedProducts = existingProducts.filter((p) => p.recipeVersion.family.deletedAt !== null);
            if (discontinuedProducts.length > 0) {
                const names = [...new Set(discontinuedProducts.map((p) => p.recipeVersion.family.name))].join('", "');
                throw new BadRequestException(`无法更新任务，因为配方 "${names}" 已被停用。`);
            }

            await tx.productionTask.update({
                where: { id },
                data: {
                    startDate,
                    endDate,
                    notes,
                    items: {
                        create: products.map((p) => ({
                            productId: p.productId,
                            quantity: p.quantity,
                        })),
                    },
                },
            });

            // 重新生成并保存快照
            const snapshot = await this._fetchAndSerializeSnapshot(id, tx);
            await tx.productionTask.update({
                where: { id },
                data: {
                    recipeSnapshot: snapshot,
                },
            });

            // 调用“组装”函数来获取返回数据
            const taskWithSnapshot = await this._getTaskWithAssembledDetails(id, tx);
            return this._sanitizeTask(taskWithSnapshot);
        });
    }

    async update(tenantId: string, id: string, updateProductionTaskDto: UpdateProductionTaskDto) {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        return this.prisma.productionTask.update({
            where: { id },
            data: updateProductionTaskDto,
        });
    }

    async remove(tenantId: string, id: string) {
        const task = await this.prisma.productionTask.findFirst({
            where: {
                id,
                tenantId,
                deletedAt: null,
            },
            select: {
                status: true,
            },
        });

        if (!task) {
            throw new NotFoundException('生产任务不存在');
        }

        if (task.status !== ProductionTaskStatus.PENDING) {
            throw new BadRequestException(
                `无法删除任务：该任务状态为 ${task.status}。只有“待开始”的任务才能被删除，进行中的任务请使用“取消”操作。`,
            );
        }

        return this.prisma.productionTask.update({
            where: { id },
            data: {
                deletedAt: new Date(),
            },
        });
    }

    async complete(tenantId: string, userId: string, id: string, completeDto: CompleteProductionTaskDto) {
        const task = await this.prisma.productionTask.findFirst({
            where: { id, tenantId, deletedAt: null },
            select: {
                items: {
                    select: {
                        productId: true,
                        quantity: true,
                    },
                },
                recipeSnapshot: true,
                status: true,
                id: true,
            },
        });

        if (!task) throw new NotFoundException('生产任务不存在');
        if (task.status !== 'PENDING' && task.status !== 'IN_PROGRESS') {
            throw new BadRequestException('只有“待开始”或“进行中”的任务才能被完成');
        }

        if (!task.recipeSnapshot) {
            throw new BadRequestException(
                '任务数据不完整，缺少配方快照，无法完成任务。请尝试编辑并重新保存任务以生成快照。',
            );
        }

        const snapshot = task.recipeSnapshot as unknown as TaskWithDetails;
        const snapshotProductMap = new Map(snapshot.items.map((i) => [i.product.id, i.product]));

        const { notes, completedItems } = completeDto;

        const totalInputNeeded = new Map<string, { name: string; totalConsumed: number }>();
        for (const item of completedItems) {
            // [核心] 计算本次任务执行的总投入原料量 (Plans)
            // 不管成功还是失败，只要投入生产，就应该按配方（含损耗）计算投入量
            const totalQuantity =
                item.completedQuantity + (item.spoilageDetails?.reduce((s, d) => s + d.quantity, 0) || 0);
            if (totalQuantity > 0) {
                const snapshotProduct = snapshotProductMap.get(item.productId);
                if (!snapshotProduct) {
                    throw new BadRequestException(`快照中未找到产品ID ${item.productId}。`);
                }

                // calculateProductConsumptionsFromSnapshot 计算的是“含损耗”的总投入量
                const consumptions = this.costingService.calculateProductConsumptionsFromSnapshot(
                    snapshotProduct,
                    totalQuantity,
                );
                for (const cons of consumptions) {
                    const existing = totalInputNeeded.get(cons.ingredientId);
                    if (existing) {
                        existing.totalConsumed += cons.totalConsumed;
                    } else {
                        totalInputNeeded.set(cons.ingredientId, {
                            name: cons.ingredientName,
                            totalConsumed: cons.totalConsumed,
                        });
                    }
                }
            }
        }

        const neededIngredientIds = Array.from(totalInputNeeded.keys());
        if (neededIngredientIds.length > 0) {
            // 库存检查 (仅检查 STANDARD)
            const ingredientsInStock = await this.prisma.ingredient.findMany({
                where: { id: { in: neededIngredientIds }, type: IngredientType.STANDARD },
                select: { id: true, name: true, currentStockInGrams: true },
            });

            const insufficientIngredients: string[] = [];

            for (const ingredient of ingredientsInStock) {
                const needed = totalInputNeeded.get(ingredient.id);
                if (!needed) continue;

                const currentStock = new Prisma.Decimal(ingredient.currentStockInGrams);
                if (currentStock.lt(needed.totalConsumed)) {
                    insufficientIngredients.push(ingredient.name);
                }
            }

            if (insufficientIngredients.length > 0) {
                throw new BadRequestException(`操作失败：原料库存不足 (${insufficientIngredients.join(', ')})`);
            }
        }

        const plannedQuantities = new Map(task.items.map((item) => [item.productId, item.quantity]));

        return this.prisma.$transaction(async (tx) => {
            // 1. 更新任务状态
            await tx.productionTask.update({
                where: { id },
                data: { status: ProductionTaskStatus.COMPLETED },
            });

            // 2. 创建生产日志
            const productionLog = await tx.productionLog.create({
                data: {
                    taskId: id,
                    notes,
                },
            });

            // 累计变量，用于计算工艺损耗和总成本
            const totalTheoreticalConsumption = new Map<string, Prisma.Decimal>(); // 成功品消耗
            const totalSpoiledConsumption = new Map<string, Prisma.Decimal>(); // 报损品消耗
            let totalTaskCost = new Prisma.Decimal(0); // 累计本任务消耗的总成本

            // 3. 处理每个产品的提交结果
            for (const completedItem of completedItems) {
                const { productId, completedQuantity, spoilageDetails } = completedItem;
                const snapshotProduct = snapshotProductMap.get(productId);
                if (!snapshotProduct) throw new BadRequestException(`快照中未找到产品ID ${productId}。`);

                const productName = snapshotProduct.name || '未知产品';
                const plannedQuantity = plannedQuantities.get(productId);

                if (plannedQuantity === undefined) {
                    throw new BadRequestException(`产品ID ${productId} 不在任务中。`);
                }

                // --- 步骤一：处理【成功产品】 ---
                if (completedQuantity > 0) {
                    const successConsumptions = this.costingService.calculateTheoreticalProductConsumptionsFromSnapshot(
                        snapshotProduct,
                        completedQuantity,
                    );

                    for (const cons of successConsumptions) {
                        // 累加理论消耗 (用于后续计算工艺损耗)
                        const current = totalTheoreticalConsumption.get(cons.ingredientId) || new Prisma.Decimal(0);
                        totalTheoreticalConsumption.set(cons.ingredientId, current.add(cons.totalConsumed));

                        // 记录消耗日志 (Step 1a)
                        await tx.ingredientConsumptionLog.create({
                            data: {
                                productionLogId: productionLog.id,
                                ingredientId: cons.ingredientId,
                                skuId: cons.activeSkuId,
                                quantityInGrams: new Prisma.Decimal(cons.totalConsumed),
                            },
                        });

                        // 扣减库存 (Step 1b)
                        const costReduced = await this._deductStockAndCalculateCost(
                            tx,
                            cons.ingredientId,
                            new Prisma.Decimal(cons.totalConsumed),
                        );
                        totalTaskCost = totalTaskCost.add(costReduced);
                    }
                }

                // --- 步骤二：处理【明确报损】 ---
                const calculatedSpoilage = spoilageDetails?.reduce((sum, s) => sum + s.quantity, 0) || 0;

                if (calculatedSpoilage > 0) {
                    // 记录报损详情
                    if (spoilageDetails) {
                        for (const spoilage of spoilageDetails) {
                            await tx.productionTaskSpoilageLog.create({
                                data: {
                                    productionLogId: productionLog.id,
                                    productId,
                                    productName: productName,
                                    stage: spoilage.stage,
                                    quantity: spoilage.quantity,
                                    notes: spoilage.notes,
                                },
                            });
                        }
                    }

                    // 计算报损品的理论消耗
                    const spoiledConsumptions = this.costingService.calculateTheoreticalProductConsumptionsFromSnapshot(
                        snapshotProduct,
                        calculatedSpoilage,
                    );

                    for (const cons of spoiledConsumptions) {
                        // 累加报损消耗
                        const current = totalSpoiledConsumption.get(cons.ingredientId) || new Prisma.Decimal(0);
                        totalSpoiledConsumption.set(cons.ingredientId, current.add(cons.totalConsumed));

                        // 记录库存调整 (Step 2a)
                        await tx.ingredientStockAdjustment.create({
                            data: {
                                ingredientId: cons.ingredientId,
                                userId: userId,
                                changeInGrams: new Prisma.Decimal(-cons.totalConsumed),
                                reason: `生产报损: ${productName}`,
                            },
                        });

                        // 扣减库存 (Step 2b)
                        const costReduced = await this._deductStockAndCalculateCost(
                            tx,
                            cons.ingredientId,
                            new Prisma.Decimal(cons.totalConsumed),
                        );
                        totalTaskCost = totalTaskCost.add(costReduced);
                    }
                }

                // 记录超产
                const calculatedOverproduction = Math.max(0, completedQuantity - (plannedQuantity || 0));
                if (calculatedOverproduction > 0) {
                    await tx.productionTaskOverproductionLog.create({
                        data: {
                            productionLogId: productionLog.id,
                            productId,
                            productName: productName,
                            quantity: calculatedOverproduction,
                        },
                    });
                }
            }

            // --- 步骤三：处理【工艺损耗】 ---
            for (const [ingId, inputData] of totalInputNeeded.entries()) {
                const theoretical = totalTheoreticalConsumption.get(ingId) || new Prisma.Decimal(0);
                const spoiled = totalSpoiledConsumption.get(ingId) || new Prisma.Decimal(0);

                // 工艺损耗 = 总投入 (配方含损耗) - 成功理论消耗 - 报损理论消耗
                const processLoss = new Prisma.Decimal(inputData.totalConsumed).sub(theoretical).sub(spoiled);

                if (processLoss.gt(0.01)) {
                    // 记录库存调整 (Step 3a)
                    await tx.ingredientStockAdjustment.create({
                        data: {
                            ingredientId: ingId,
                            userId: userId,
                            changeInGrams: processLoss.negated(), // 负数表示减少
                            reason: `工艺损耗: 任务 #${task.id.substring(0, 8)}`,
                        },
                    });

                    // 扣减库存 (Step 3b)
                    const costReduced = await this._deductStockAndCalculateCost(tx, ingId, processLoss);
                    totalTaskCost = totalTaskCost.add(costReduced);
                }
            }

            // --- 步骤四：【自制原料入库】 ---
            // 检查任务的第一个产品是否属于 PRE_DOUGH 或 EXTRA 配方
            const firstProduct = snapshot.items[0]?.product;
            const recipeFamily = firstProduct?.recipeVersion.family;

            if (
                recipeFamily &&
                (recipeFamily.type === RecipeType.PRE_DOUGH || recipeFamily.type === RecipeType.EXTRA)
            ) {
                // 查找该配方关联的 Output Ingredient
                // 注意：snapshot 中可能没有 outputIngredient 字段 (因为是旧快照)
                // 所以我们实时查询一次
                const familyWithOutput = await tx.recipeFamily.findUnique({
                    where: { id: recipeFamily.id },
                    include: { outputIngredient: true },
                });

                const outputIngredient = familyWithOutput?.outputIngredient;

                if (outputIngredient) {
                    // 计算总产出量 (假设所有产品的 quantity 都是重量，单位 g)
                    // 对于自制原料任务，我们在 create 时会将 Product 的 weight 设为 1，quantity 设为总克重
                    // 或者 quantity 为份数，product.weight 为每份重量
                    // 无论哪种，总产出 = sum(completedQuantity * product.baseDoughWeight)
                    let totalProducedWeight = new Prisma.Decimal(0);
                    for (const item of completedItems) {
                        const product = snapshotProductMap.get(item.productId);
                        if (product) {
                            totalProducedWeight = totalProducedWeight.add(
                                new Prisma.Decimal(item.completedQuantity).mul(product.baseDoughWeight),
                            );
                        }
                    }

                    if (totalProducedWeight.gt(0)) {
                        // 更新库存和成本
                        // 新库存 = 旧库存 + 产出
                        // 新总价值 = 旧总价值 + 本次任务总成本
                        await tx.ingredient.update({
                            where: { id: outputIngredient.id },
                            data: {
                                currentStockInGrams: { increment: totalProducedWeight },
                                currentStockValue: { increment: totalTaskCost },
                            },
                        });

                        // 记录入库流水 (可选，复用 ADJUSTMENT 或新增 PRODUCTION_IN)
                        await tx.ingredientStockAdjustment.create({
                            data: {
                                ingredientId: outputIngredient.id,
                                userId: userId,
                                changeInGrams: totalProducedWeight,
                                reason: `生产入库: 任务 #${task.id.substring(0, 8)}`,
                            },
                        });
                    }
                }
            }

            return this.findOne(tenantId, id, {});
        });
    }

    // 辅助函数：扣减库存并返回扣减的成本价值
    private async _deductStockAndCalculateCost(
        tx: Prisma.TransactionClient,
        ingredientId: string,
        amount: Prisma.Decimal,
    ): Promise<Prisma.Decimal> {
        const ingredient = await tx.ingredient.findUnique({ where: { id: ingredientId } });
        if (!ingredient) return new Prisma.Decimal(0);

        let valueToDecrement = new Prisma.Decimal(0);

        // 如果是 STANDARD 或 SELF_MADE，需要计算成本
        if (
            ingredient.type === IngredientType.STANDARD ||
            ingredient.type === IngredientType.SELF_MADE ||
            ingredient.type === IngredientType.NON_INVENTORIED
        ) {
            // 计算加权平均成本
            if (ingredient.currentStockInGrams.gt(0)) {
                const avgPricePerGram = ingredient.currentStockValue.div(ingredient.currentStockInGrams);
                valueToDecrement = avgPricePerGram.mul(amount);
            } else {
                // 如果库存 <= 0，无法准确计算成本，暂按 0 处理或使用上次采购价 (这里简化为 0)
                valueToDecrement = new Prisma.Decimal(0);
            }
        }

        // 执行扣减
        await tx.ingredient.update({
            where: { id: ingredientId },
            data: {
                currentStockInGrams: { decrement: amount },
                currentStockValue: { decrement: valueToDecrement },
            },
        });

        return valueToDecrement;
    }

    // [新增] PDF 生成核心逻辑
    async generatePdf(tenantId: string, taskId: string): Promise<NodeJS.ReadableStream> {
        const taskDetail = await this.findOne(tenantId, taskId, {});

        const fontPath = path.join(process.cwd(), 'dist/assets/fonts');
        const fonts = {
            Roboto: {
                normal: path.join(fontPath, 'NotoSansSC-Regular.ttf'),
                bold: path.join(fontPath, 'NotoSansSC-Bold.ttf'),
                italics: path.join(fontPath, 'NotoSansSC-Regular.ttf'),
                bolditalics: path.join(fontPath, 'NotoSansSC-Bold.ttf'),
            },
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        const printer = new PdfPrinter(fonts);

        const formatWeight = (grams: number | null | undefined): string => {
            if (grams === null || grams === undefined) return '-';
            const num = Number(grams);
            if (isNaN(num)) return '-';
            if (Math.abs(num) === 0) return '0g';
            if (Math.abs(num) < 10000) {
                return `${parseFloat(num.toFixed(2))}g`;
            } else {
                return `${parseFloat((num / 1000).toFixed(2))}kg`;
            }
        };

        const content: any[] = [];

        // --- 头部信息 ---
        content.push({ text: '生产任务单', style: 'header', alignment: 'center' });

        // 单独获取任务日期信息
        const taskMetadata = await this.prisma.productionTask.findUnique({
            where: { id: taskId },
            select: { startDate: true },
        });
        const dateStr = taskMetadata ? taskMetadata.startDate.toISOString().split('T')[0] : '';

        if (dateStr) {
            content.push({
                text: `执行日期: ${dateStr}`,
                style: 'subHeader',
                alignment: 'center',
                margin: [0, 0, 0, 5],
            });
        }

        const infoTable = {
            width: '100%',
            columns: [
                { text: `任务ID: #${taskDetail.id.substring(0, 8)}`, style: 'subHeader' },
                { text: `状态: ${taskDetail.status}`, style: 'subHeader', alignment: 'right' },
            ],
        };
        content.push(infoTable);
        content.push({ text: '\n' });

        if (taskDetail.stockWarning) {
            content.push({
                text: `[警] ${taskDetail.stockWarning}`,
                style: 'warningBox',
                margin: [0, 0, 0, 10],
            });
        }

        // --- 循环配方组 ---
        taskDetail.componentGroups.forEach((group, index) => {
            // [核心修改] 移除强制分页，改用较大的顶部间距来区分
            // 第一个组顶部间距 10，后续组顶部间距 40 (留白)
            const topMargin = index > 0 ? 40 : 10;

            content.push({
                text: `${group.familyName} ${group.note ? `(${group.note})` : ''}`,
                style: 'groupTitle',
                margin: [0, topMargin, 0, 5],
                // pageBreak 已移除
            });

            content.push({ text: group.productsDescription, style: 'desc', margin: [0, 0, 0, 10] });

            // 1. 配方总表 (面团/主料)
            const body: any[] = [];
            body.push([
                { text: '完成', style: 'tableHeader' },
                { text: '原料名称', style: 'tableHeader' },
                { text: '品牌/备注', style: 'tableHeader' },
                { text: '用量', style: 'tableHeader', alignment: 'right' },
            ]);

            for (const ing of group.baseComponentIngredients) {
                body.push([
                    { text: '□', style: 'checkbox' },
                    { text: ing.name, style: ing.isRecipe ? 'recipeName' : 'text' },
                    { text: `${ing.brand || '-'}\n${ing.extraInfo || ''}`, style: 'smallText' },
                    { text: formatWeight(ing.weightInGrams), style: 'weightNumber', alignment: 'right' },
                ]);
            }

            content.push({
                table: {
                    headerRows: 1,
                    keepWithHeaderRows: 1,
                    widths: ['10%', '40%', '30%', '20%'],
                    body: body,
                    dontBreakRows: true,
                },
                layout: 'lightHorizontalLines',
                margin: [0, 0, 0, 15],
            });

            // 2. 制作步骤
            if (group.baseComponentProcedure && group.baseComponentProcedure.length > 0) {
                content.push({ text: '制作步骤:', style: 'sectionHeader' });
                const steps = group.baseComponentProcedure.map((step, idx) => {
                    return { text: `${idx + 1}. ${step}`, margin: [0, 2, 0, 2], fontSize: 11 };
                });
                content.push({ stack: steps, margin: [0, 0, 0, 15] });
            }

            // 统一列宽
            const unifiedWidths = ['30%', '30%', '20%', '20%'];

            // 3. 产品详情
            for (const product of group.productDetails) {
                content.push({
                    text: `产品: ${product.name}`,
                    style: 'productTitle',
                    margin: [0, 10, 0, 5],
                });

                // A. 基础原料表格
                const baseInfoBody: any[] = [];
                baseInfoBody.push([
                    { text: '基础原料', style: 'tableHeader' },
                    { text: '总重', style: 'tableHeader', alignment: 'right' },
                    { text: '产品数量', style: 'tableHeader', alignment: 'center' },
                    { text: '分割重量', style: 'tableHeader', alignment: 'right' },
                ]);

                baseInfoBody.push([
                    { text: product.baseComponent.name, style: 'text' },
                    {
                        text: formatWeight(product.baseComponent.totalBaseComponentWeight),
                        style: 'weightNumber',
                        alignment: 'right',
                    },
                    { text: product.baseComponent.quantity.toString(), style: 'text', alignment: 'center' },
                    {
                        text: formatWeight(product.baseComponent.divisionWeight),
                        style: 'weightNumber',
                        alignment: 'right',
                    },
                ]);

                content.push({
                    table: {
                        headerRows: 1,
                        keepWithHeaderRows: 1,
                        widths: unifiedWidths,
                        body: baseInfoBody,
                        dontBreakRows: true,
                    },
                    layout: 'lightHorizontalLines',
                    margin: [0, 0, 0, 10],
                });

                // B. 辅料表格
                if (product.mixIns.length > 0) {
                    const mixInsBody: any[] = [];
                    mixInsBody.push([
                        { text: '辅料', style: 'tableHeader' },
                        { text: '品牌', style: 'tableHeader' },
                        { text: '', style: 'tableHeader' },
                        { text: '总用量', style: 'tableHeader', alignment: 'right' },
                    ]);
                    for (const ing of product.mixIns) {
                        mixInsBody.push([
                            { text: ing.name },
                            { text: ing.brand || '-', style: 'smallText' },
                            { text: '-', alignment: 'center', style: 'smallText' },
                            { text: formatWeight(ing.weightInGrams), style: 'weightNumber', alignment: 'right' },
                        ]);
                    }
                    content.push({
                        table: {
                            headerRows: 1,
                            keepWithHeaderRows: 1,
                            widths: unifiedWidths,
                            body: mixInsBody,
                            dontBreakRows: true,
                        },
                        layout: 'lightHorizontalLines',
                        margin: [0, 0, 0, 10],
                    });
                }

                // C. 馅料表格
                if (product.fillings.length > 0) {
                    const fillingsBody: any[] = [];
                    fillingsBody.push([
                        { text: '馅料', style: 'tableHeader' },
                        { text: '品牌', style: 'tableHeader' },
                        { text: '单个用量', style: 'tableHeader', alignment: 'right' },
                        { text: '总用量', style: 'tableHeader', alignment: 'right' },
                    ]);
                    for (const ing of product.fillings) {
                        const item = ing as typeof ing & { weightPerUnit?: number };
                        fillingsBody.push([
                            { text: ing.name },
                            { text: ing.brand || '-', style: 'smallText' },
                            { text: formatWeight(item.weightPerUnit), alignment: 'right', style: 'weightNumber' },
                            { text: formatWeight(ing.weightInGrams), style: 'weightNumber', alignment: 'right' },
                        ]);
                    }
                    content.push({
                        table: {
                            headerRows: 1,
                            keepWithHeaderRows: 1,
                            widths: unifiedWidths,
                            body: fillingsBody,
                            dontBreakRows: true,
                        },
                        layout: 'lightHorizontalLines',
                        margin: [0, 0, 0, 10],
                    });
                }

                // D. 装饰表格
                if (product.toppings && product.toppings.length > 0) {
                    const toppingsBody: any[] = [];
                    toppingsBody.push([
                        { text: '表面装饰', style: 'tableHeader' },
                        { text: '品牌', style: 'tableHeader' },
                        { text: '单个用量', style: 'tableHeader', alignment: 'right' },
                        { text: '总用量', style: 'tableHeader', alignment: 'right' },
                    ]);
                    for (const ing of product.toppings) {
                        const item = ing as typeof ing & { weightPerUnit?: number };
                        toppingsBody.push([
                            { text: ing.name },
                            { text: ing.brand || '-', style: 'smallText' },
                            { text: formatWeight(item.weightPerUnit), alignment: 'right', style: 'weightNumber' },
                            { text: formatWeight(ing.weightInGrams), style: 'weightNumber', alignment: 'right' },
                        ]);
                    }
                    content.push({
                        table: {
                            headerRows: 1,
                            keepWithHeaderRows: 1,
                            widths: unifiedWidths,
                            body: toppingsBody,
                            dontBreakRows: true,
                        },
                        layout: 'lightHorizontalLines',
                        margin: [0, 0, 0, 10],
                    });
                }

                // E. 产品制作步骤
                if (product.procedure && product.procedure.length > 0) {
                    const procSteps = product.procedure.map((step, idx) => {
                        return { text: `${idx + 1}. ${step}`, margin: [0, 2, 0, 2], fontSize: 11 };
                    });
                    content.push({ stack: procSteps, margin: [10, 0, 0, 15] });
                }
            }
        });

        // --- 底部记录区 ---
        content.push({ canvas: [{ type: 'line', x1: 0, y1: 5, x2: 515, y2: 5, lineWidth: 1 }] });
        content.push({ text: '\n生产记录 (手写)', style: 'sectionHeader' });
        content.push({
            table: {
                widths: ['50%', '50%'],
                heights: [60],
                body: [
                    [
                        { text: '实际产出数量:\n\n', color: '#aaaaaa' },
                        { text: '损耗/异常记录:\n\n', color: '#aaaaaa' },
                    ],
                ],
            },
        });

        const docDefinition: any = {
            content: content,
            styles: {
                header: { fontSize: 22, bold: true, margin: [0, 0, 0, 10] },
                subHeader: { fontSize: 10, color: '#555555' },
                groupTitle: { fontSize: 16, bold: true, color: '#333333' },
                productTitle: { fontSize: 12, bold: true, color: '#666666', decoration: 'underline' },
                desc: { fontSize: 10, italics: true, color: '#666666' },
                tableHeader: { fontSize: 10, bold: true, color: 'black', fillColor: '#eeeeee' },
                checkbox: { fontSize: 14, alignment: 'center' },
                weightNumber: { fontSize: 12, bold: true },
                text: { fontSize: 11 },
                smallText: { fontSize: 9, color: '#666666' },
                recipeName: { fontSize: 11, bold: true, color: '#2c3e50' },
                sectionHeader: { fontSize: 12, bold: true, margin: [0, 5, 0, 5] },
                warningBox: { fontSize: 12, bold: true, color: 'red', background: '#ffe6e6' },
            },
            defaultStyle: {
                font: 'Roboto',
            },
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const doc = printer.createPdfKitDocument(docDefinition);

        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        doc.end();

        return doc as NodeJS.ReadableStream;
    }

    // [新增] 生成前置任务 PDF
    async generatePrepTaskPdf(tenantId: string, date: string): Promise<NodeJS.ReadableStream> {
        // 1. 获取数据
        const prepTask = await this.getPrepTaskDetails(tenantId, date);
        if (!prepTask) {
            throw new NotFoundException('未找到该日期的前置任务');
        }

        // 2. 定义字体
        const fontPath = path.join(process.cwd(), 'dist/assets/fonts');
        const fonts = {
            Roboto: {
                normal: path.join(fontPath, 'NotoSansSC-Regular.ttf'),
                bold: path.join(fontPath, 'NotoSansSC-Bold.ttf'),
                italics: path.join(fontPath, 'NotoSansSC-Regular.ttf'),
                bolditalics: path.join(fontPath, 'NotoSansSC-Bold.ttf'),
            },
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
        const printer = new PdfPrinter(fonts);

        // 格式化工具
        const formatWeight = (grams: number | null | undefined): string => {
            if (grams === null || grams === undefined) return '-';
            const num = Number(grams);
            if (isNaN(num)) return '-';
            if (Math.abs(num) === 0) return '0g';
            if (Math.abs(num) < 10000) {
                return `${parseFloat(num.toFixed(2))}g`;
            } else {
                return `${parseFloat((num / 1000).toFixed(2))}kg`;
            }
        };

        const content: any[] = [];

        // --- 头部 ---
        content.push({ text: '前置备料单', style: 'header', alignment: 'center' });
        content.push({ text: `执行日期: ${date}`, style: 'subHeader', alignment: 'center', margin: [0, 0, 0, 20] });

        let sectionCounter = 1;
        const getSectionTitle = (title: string) => {
            const chineseNumbers = ['一', '二', '三', '四', '五'];
            const prefix = chineseNumbers[sectionCounter - 1] || sectionCounter.toString();
            sectionCounter++;
            return `${prefix}、${title}`;
        };

        // --- 第一部分：备料清单 (汇总) ---
        if (prepTask.billOfMaterials) {
            const { standardItems, nonInventoriedItems } = prepTask.billOfMaterials;

            if (standardItems.length > 0 || nonInventoriedItems.length > 0) {
                content.push({ text: getSectionTitle('原料领用汇总'), style: 'sectionHeader', margin: [0, 10, 0, 5] });

                const bomBody: any[] = [];
                bomBody.push([
                    { text: '原料名称', style: 'tableHeader' },
                    { text: '品牌', style: 'tableHeader' },
                    { text: '库存', style: 'tableHeader', alignment: 'right' },
                    { text: '总需求量', style: 'tableHeader', alignment: 'right' },
                ]);

                // 标准原料
                standardItems.forEach((item) => {
                    bomBody.push([
                        { text: item.ingredientName, style: 'text' },
                        { text: item.brand || '-', style: 'smallText' },
                        { text: formatWeight(item.currentStock), style: 'smallText', alignment: 'right' },
                        { text: formatWeight(item.totalRequired), style: 'weightNumber', alignment: 'right' },
                    ]);
                });

                // 即时采购原料
                nonInventoriedItems.forEach((item) => {
                    bomBody.push([
                        { text: item.ingredientName, style: 'text' },
                        { text: item.brand || '-', style: 'smallText' },
                        { text: '即时采购', style: 'smallText', alignment: 'right', color: '#d4a373' },
                        { text: formatWeight(item.totalRequired), style: 'weightNumber', alignment: 'right' },
                    ]);
                });

                content.push({
                    table: {
                        headerRows: 1,
                        keepWithHeaderRows: 1,
                        widths: ['35%', '25%', '20%', '20%'],
                        body: bomBody,
                        dontBreakRows: true,
                    },
                    layout: 'lightHorizontalLines',
                    margin: [0, 0, 0, 15],
                });
            }
        }

        // --- 辅助函数：渲染制作任务卡片 ---
        const renderTaskItems = (items: RenderTaskItem[], title: string) => {
            if (items.length === 0) return;

            content.push({ text: getSectionTitle(title), style: 'sectionHeader', margin: [0, 30, 0, 5] });

            items.forEach((item, index) => {
                content.push({
                    text: `${index + 1}. ${item.name}`,
                    style: 'groupTitle',
                    margin: [0, 15, 0, 5],
                });

                content.push({
                    text: `目标总重: ${formatWeight(item.totalWeight)}${item.targetWeight ? ` (需求: ${formatWeight(item.targetWeight)})` : ''}`,
                    style: 'desc',
                    margin: [0, 0, 0, 5],
                });

                // 配方表
                const body: any[] = [];
                body.push([
                    { text: '完成', style: 'tableHeader' },
                    { text: '原料', style: 'tableHeader' },
                    { text: '品牌/备注', style: 'tableHeader' },
                    { text: '用量', style: 'tableHeader', alignment: 'right' },
                ]);

                item.ingredients.forEach((ing) => {
                    const extraInfo = ing.extraInfo || '';

                    body.push([
                        { text: '□', style: 'checkbox' },
                        { text: ing.name, style: 'text' },
                        { text: `${ing.isRecipe ? '自制' : ing.brand || '-'}\n${extraInfo}`, style: 'smallText' },
                        { text: formatWeight(ing.weightInGrams), style: 'weightNumber', alignment: 'right' },
                    ]);
                });

                content.push({
                    table: {
                        headerRows: 1,
                        keepWithHeaderRows: 1,
                        widths: ['10%', '40%', '30%', '20%'],
                        body: body,
                        dontBreakRows: true,
                    },
                    layout: 'lightHorizontalLines',
                    margin: [0, 0, 0, 10],
                });

                // 制作步骤
                if (item.procedure && item.procedure.length > 0) {
                    const steps = item.procedure.map((step, idx) => ({
                        text: `${idx + 1}. ${step}`,
                        style: 'text',
                        margin: [0, 2, 0, 2],
                    }));
                    content.push({
                        stack: steps,
                        margin: [10, 0, 0, 15],
                        color: '#555555',
                    });
                }
            });
        };

        // [核心修复] 映射数据逻辑
        if (prepTask.items && prepTask.items.length > 0) {
            const mapToRenderItem = (item: CalculatedRecipeDetails): RenderTaskItem => ({
                name: item.name,
                totalWeight: item.totalWeight,
                targetWeight: item.targetWeight,
                ingredients: item.ingredients.map((ing) => ({
                    name: ing.name,
                    isRecipe: ing.isRecipe,
                    brand: ing.brand,
                    // [修复] 使用交叉类型断言，彻底解决 ESLint 报错
                    // 这样 ing 既保留了原有类型，又被告知可能含有 extraInfo，从而消除 any
                    extraInfo: (ing as typeof ing & { extraInfo?: string }).extraInfo || null,
                    weightInGrams: ing.weightInGrams,
                })),
                procedure: item.procedure,
            });

            // 筛选并转换面种
            const preDoughs = prepTask.items.filter((item) => item.type === 'PRE_DOUGH').map(mapToRenderItem);

            // 筛选并转换馅料/辅料
            const extras = prepTask.items.filter((item) => item.type === 'EXTRA').map(mapToRenderItem);

            // 渲染面种部分
            if (preDoughs.length > 0) {
                renderTaskItems(preDoughs, '面种制作');
            }

            // 渲染馅料部分
            if (extras.length > 0) {
                renderTaskItems(extras, '馅料/辅料制作');
            }
        }

        // 底部备注
        content.push({ text: '\n' });
        content.push({ canvas: [{ type: 'line', x1: 0, y1: 5, x2: 515, y2: 5, lineWidth: 1 }] });
        content.push({
            text: '备注 / 异常记录:',
            style: 'smallText',
            margin: [0, 5, 0, 0],
            color: '#aaaaaa',
        });

        // 样式定义
        const docDefinition: any = {
            content: content,
            styles: {
                header: { fontSize: 20, bold: true, margin: [0, 0, 0, 5] },
                subHeader: { fontSize: 12, color: '#555555' },
                sectionHeader: { fontSize: 14, bold: true, color: '#333333', margin: [0, 5, 0, 5] },
                // [修改] 颜色改为黑色
                groupTitle: { fontSize: 13, bold: true, color: '#333333' },
                desc: { fontSize: 10, italics: true, color: '#666666' },
                tableHeader: { fontSize: 10, bold: true, color: 'black', fillColor: '#eeeeee' },
                checkbox: { fontSize: 14, alignment: 'center' },
                weightNumber: { fontSize: 11, bold: true },
                text: { fontSize: 10 },
                smallText: { fontSize: 9, color: '#666666' },
            },
            defaultStyle: {
                font: 'Roboto',
            },
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const doc = printer.createPdfKitDocument(docDefinition);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        doc.end();

        return doc as NodeJS.ReadableStream;
    }
}
