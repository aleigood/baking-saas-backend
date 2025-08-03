import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { RecipeFamily, RecipeVersion, ProductIngredientType } from '@prisma/client';

// 为配方族及其版本定义一个更精确的类型，以帮助TypeScript进行类型推断
type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

@Injectable()
export class RecipesService {
    constructor(private prisma: PrismaService) {}

    /**
     * 创建一个全新的配方版本。
     * 如果同名配方族不存在，则创建配方族及V1版本。
     * 如果存在，则在该配方族下创建下一个版本。
     * @param tenantId 租户ID
     * @param createRecipeDto 配方数据
     * @returns 创建的配方版本
     */
    async create(tenantId: string, createRecipeDto: CreateRecipeDto) {
        const { name, type = 'MAIN', ingredients, products, procedure, targetTemp, lossRatio } = createRecipeDto;

        // 核心业务逻辑：使用数据库事务确保数据一致性
        return this.prisma.$transaction(async (tx) => {
            // 步骤 1: 查找或创建配方族 (RecipeFamily)
            let recipeFamily: RecipeFamilyWithVersions | null = await tx.recipeFamily.findFirst({
                where: {
                    tenantId,
                    name,
                    deletedAt: null, // 仅查找未被软删除的
                },
                include: {
                    versions: true, // 包含所有版本以计算下一个版本号
                },
            });

            if (!recipeFamily) {
                recipeFamily = await tx.recipeFamily.create({
                    data: {
                        name,
                        tenantId,
                        type,
                    },
                    include: { versions: true },
                });
            }

            // 步骤 2: 确定新版本号
            const nextVersionNumber =
                recipeFamily.versions.length > 0 ? Math.max(...recipeFamily.versions.map((v) => v.version)) + 1 : 1;

            // 步骤 3: 校验预制面团依赖是否存在 (仅在创建主配方时)
            if (type === 'MAIN') {
                for (const ingredient of ingredients) {
                    // 检查该原料是否可能是预制面团
                    const preDoughRecipe = await tx.recipeFamily.findFirst({
                        where: {
                            name: ingredient.name,
                            tenantId: tenantId,
                            type: 'PRE_DOUGH',
                            deletedAt: null,
                        },
                    });
                    if (preDoughRecipe) {
                        // 如果找到了同名的预制面团配方，就进行关联。
                        // 实际业务中可能还需要校验其成分比例是否一致，这里先做关联。
                        console.log(`配方 "${name}" 中的原料 "${ingredient.name}" 关联到预制面团配方。`);
                    }
                }
            }

            // 步骤 4: 创建配方版本 (RecipeVersion)
            const recipeVersion = await tx.recipeVersion.create({
                data: {
                    familyId: recipeFamily.id,
                    version: nextVersionNumber,
                    notes: `版本 ${nextVersionNumber} 初始创建`,
                    isActive: true, // 新版本默认为激活状态
                },
            });

            // 步骤 5: 创建面团 (Dough)
            // 对于一个配方，我们简化处理，认为它只有一个主面团定义
            const dough = await tx.dough.create({
                data: {
                    recipeVersionId: recipeVersion.id,
                    name: '主面团', // 或从DTO中获取
                    targetTemp,
                    lossRatio,
                    procedure,
                },
            });

            // 步骤 6: 创建面团中的原料 (DoughIngredient)
            for (const ingredientDto of ingredients) {
                // 检查并关联预制面团
                const linkedPreDough = await tx.recipeFamily.findFirst({
                    where: {
                        name: ingredientDto.name,
                        tenantId: tenantId,
                        type: 'PRE_DOUGH',
                        deletedAt: null,
                    },
                });

                await tx.doughIngredient.create({
                    data: {
                        doughId: dough.id,
                        name: ingredientDto.name,
                        ratio: ingredientDto.ratio,
                        isFlour: ingredientDto.isFlour ?? false,
                        waterContent: ingredientDto.waterContent,
                        linkedPreDoughId: linkedPreDough?.id, // 如果找到，则关联ID
                    },
                });
            }

            // 步骤 7: 如果是主配方，创建最终产品 (Product) 及其附加原料
            if (type === 'MAIN' && products) {
                for (const productDto of products) {
                    const product = await tx.product.create({
                        data: {
                            recipeVersionId: recipeVersion.id,
                            name: productDto.name,
                            baseDoughWeight: productDto.weight,
                            procedure: productDto.procedure,
                        },
                    });

                    // 合并所有附加原料并使用正确的枚举类型
                    const allProductIngredients = [
                        ...(productDto.mixIn?.map((i) => ({
                            ...i,
                            type: ProductIngredientType.MIX_IN,
                        })) ?? []),
                        ...(productDto.fillings?.map((i) => ({
                            ...i,
                            type: ProductIngredientType.FILLING,
                        })) ?? []),
                        ...(productDto.toppings?.map((i) => ({
                            ...i,
                            type: ProductIngredientType.TOPPING,
                        })) ?? []),
                    ];

                    for (const pIngredientDto of allProductIngredients) {
                        // 检查并关联馅料等子配方
                        const linkedExtra = await tx.recipeFamily.findFirst({
                            where: {
                                name: pIngredientDto.name,
                                tenantId: tenantId,
                                type: 'EXTRA',
                                deletedAt: null,
                            },
                        });

                        await tx.productIngredient.create({
                            data: {
                                productId: product.id,
                                name: pIngredientDto.name,
                                type: pIngredientDto.type,
                                ratio: pIngredientDto.ratio,
                                weightInGrams: pIngredientDto.weightInGrams,
                                linkedExtraId: linkedExtra?.id, // 如果找到，则关联ID
                            },
                        });
                    }
                }
            }

            // 步骤 8: 返回完整创建的配方版本数据
            return tx.recipeVersion.findUnique({
                where: { id: recipeVersion.id },
                include: {
                    family: true,
                    doughs: {
                        include: {
                            ingredients: true,
                        },
                    },
                    products: {
                        include: {
                            ingredients: true,
                        },
                    },
                },
            });
        });
    }

    /**
     * 查找租户下的所有配方族
     * @param tenantId 租户ID
     */
    async findAll(tenantId: string) {
        return this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                deletedAt: null,
            },
            include: {
                // 默认只展示每个配方族的激活版本信息
                versions: {
                    where: { isActive: true },
                    include: {
                        products: true,
                    },
                },
            },
        });
    }

    /**
     * 根据配方族ID查找其所有版本或特定版本
     * @param familyId 配方族ID
     * @param versionNumber 可选的版本号
     */
    async findOne(familyId: string, versionNumber?: number) {
        const family = await this.prisma.recipeFamily.findFirst({
            where: {
                id: familyId,
                deletedAt: null,
            },
            include: {
                versions: {
                    where: {
                        ...(versionNumber ? { version: versionNumber } : { isActive: true }),
                    },
                    include: {
                        doughs: { include: { ingredients: true } },
                        products: { include: { ingredients: true } },
                    },
                    orderBy: { version: 'desc' },
                },
            },
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }
        return family;
    }

    /**
     * 软删除一个配方族及其所有版本
     * @param familyId 配方族ID
     */
    async remove(familyId: string) {
        const family = await this.prisma.recipeFamily.findUnique({
            where: { id: familyId },
        });
        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }
        return this.prisma.recipeFamily.update({
            where: { id: familyId },
            data: { deletedAt: new Date() },
        });
    }
}
