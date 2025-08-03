import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Decimal } from '@prisma/client/runtime/library';
// [FIX] 明确导入 Prisma 类型，以增强类型安全
import { Ingredient, IngredientSKU } from '@prisma/client';

// [FIX] 为 getIngredientsWithActiveSku 的返回类型定义一个明确的接口
// 这有助于 TypeScript 理解我们查询的数据结构，并解决类型推断错误
type IngredientWithActiveSku = Ingredient & {
    activeSku: IngredientSKU | null;
};

// 定义一个内部接口，用于在计算过程中传递消耗信息
interface ConsumptionDetail {
    ingredientId: string;
    ingredientName: string;
    activeSkuId: string | null;
    totalConsumed: number;
}

@Injectable()
export class CostingService {
    constructor(private readonly prisma: PrismaService) {}

    // 计算单个产品的成本
    async calculateProductCost(tenantId: string, productId: string) {
        const product = await this.prisma.product.findFirst({
            where: {
                id: productId,
                recipeVersion: { family: { tenantId } },
            },
            // 包含计算所需的所有关联数据
            include: {
                recipeVersion: {
                    include: {
                        doughs: {
                            include: {
                                ingredients: true,
                            },
                        },
                    },
                },
                ingredients: true,
            },
        });

        if (!product) {
            throw new NotFoundException('产品不存在');
        }

        const ingredientsMap = await this.getIngredientsWithActiveSku(tenantId);

        let totalCost = new Decimal(0);

        // 1. 计算所有面团的成本
        for (const dough of product.recipeVersion.doughs) {
            let totalFlourWeight = 0;
            for (const ingredient of dough.ingredients) {
                if (ingredient.isFlour) {
                    totalFlourWeight += product.baseDoughWeight;
                }
            }

            for (const doughIngredient of dough.ingredients) {
                const ingredientInfo = ingredientsMap.get(doughIngredient.name);
                // [FIX] 增加健壮性检查，仅当原料信息和其激活的SKU都存在时才计算成本
                if (ingredientInfo?.activeSku) {
                    const pricePerGram = new Decimal(ingredientInfo.activeSku.currentPricePerPackage).div(
                        ingredientInfo.activeSku.specWeightInGrams,
                    );

                    const weight = (totalFlourWeight * doughIngredient.ratio) / (1 - dough.lossRatio);
                    const cost = pricePerGram.mul(weight);
                    totalCost = totalCost.add(cost);
                }
            }
        }

        // 2. 计算所有附加原料的成本
        for (const productIngredient of product.ingredients) {
            const ingredientInfo = ingredientsMap.get(productIngredient.name);
            // [FIX] 增加健壮性检查
            if (ingredientInfo?.activeSku && productIngredient.weightInGrams) {
                const pricePerGram = new Decimal(ingredientInfo.activeSku.currentPricePerPackage).div(
                    ingredientInfo.activeSku.specWeightInGrams,
                );

                const cost = pricePerGram.mul(productIngredient.weightInGrams);
                totalCost = totalCost.add(cost);
            }
        }

        return {
            productId: product.id,
            productName: product.name,
            totalCost: totalCost.toFixed(4),
        };
    }

    /**
     * [FIX] 重构此方法以解决类型错误并优化逻辑
     * 计算生产指定数量产品所需的所有原料消耗量
     * @param tenantId 租户ID
     * @param productId 产品ID
     * @param quantity 生产数量
     * @returns 消耗详情列表
     */
    async calculateProductConsumptions(
        tenantId: string,
        productId: string,
        quantity: number,
    ): Promise<ConsumptionDetail[]> {
        const product = await this.prisma.product.findFirst({
            where: {
                id: productId,
                recipeVersion: { family: { tenantId } },
            },
            include: {
                recipeVersion: {
                    include: {
                        doughs: { include: { ingredients: true } },
                    },
                },
                ingredients: true,
            },
        });

        if (!product) {
            throw new NotFoundException('产品不存在');
        }

        // 步骤 1: 创建一个简单的Map来聚合每种原料名称的总消耗量
        const consumptionWeightMap = new Map<string, number>();

        // 计算面团原料消耗
        for (const dough of product.recipeVersion.doughs) {
            let totalFlourWeight = 0;
            for (const ingredient of dough.ingredients) {
                if (ingredient.isFlour) {
                    totalFlourWeight += product.baseDoughWeight;
                }
            }

            for (const doughIngredient of dough.ingredients) {
                const weight = ((totalFlourWeight * doughIngredient.ratio) / (1 - dough.lossRatio)) * quantity;

                const currentWeight = consumptionWeightMap.get(doughIngredient.name) || 0;
                consumptionWeightMap.set(doughIngredient.name, currentWeight + weight);
            }
        }

        // 计算附加原料消耗
        for (const productIngredient of product.ingredients) {
            if (productIngredient.weightInGrams) {
                const weight = productIngredient.weightInGrams * quantity;
                const currentWeight = consumptionWeightMap.get(productIngredient.name) || 0;
                consumptionWeightMap.set(productIngredient.name, currentWeight + weight);
            }
        }

        // 步骤 2: 从数据库中一次性获取所有涉及到的原料的ID和激活SKU ID
        const ingredientNames = Array.from(consumptionWeightMap.keys());
        if (ingredientNames.length === 0) {
            return [];
        }

        const ingredients = await this.prisma.ingredient.findMany({
            where: {
                tenantId,
                name: { in: ingredientNames },
            },
            select: {
                id: true,
                name: true,
                activeSkuId: true,
            },
        });

        // 步骤 3: 组合消耗量和原料信息，生成最终结果
        const result: ConsumptionDetail[] = [];
        for (const ingredient of ingredients) {
            const totalConsumed = consumptionWeightMap.get(ingredient.name);
            if (totalConsumed) {
                result.push({
                    ingredientId: ingredient.id,
                    ingredientName: ingredient.name,
                    activeSkuId: ingredient.activeSkuId,
                    totalConsumed,
                });
            }
        }

        return result;
    }

    /**
     * [FIX] 修复类型定义并添加注释
     * 预加载租户的所有原料及其激活的SKU
     * @param tenantId 租户ID
     * @returns Map<ingredientName, IngredientWithActiveSku>
     */
    private async getIngredientsWithActiveSku(tenantId: string): Promise<Map<string, IngredientWithActiveSku>> {
        // 注意：如果此处仍然报错，提示 'activeSku' 不存在，
        // 请务必在终端中运行 'npx prisma generate' 命令。
        // 这是因为 schema.prisma 文件更新后，需要重新生成 Prisma Client 类型定义。
        const ingredients = await this.prisma.ingredient.findMany({
            where: { tenantId, deletedAt: null },
            include: {
                activeSku: true,
            },
        });

        return new Map(ingredients.map((i) => [i.name, i as IngredientWithActiveSku]));
    }
}
