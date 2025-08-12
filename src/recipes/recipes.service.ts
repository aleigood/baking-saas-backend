import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
// [修改] 导入Prisma，用于指定事务隔离级别
import { Prisma, RecipeFamily, RecipeVersion, ProductIngredientType } from '@prisma/client';

// 为配方族及其版本定义一个更精确的类型，以帮助TypeScript进行类型推断
type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

@Injectable()
export class RecipesService {
    constructor(private prisma: PrismaService) {}

    /**
     * [核心重构] 创建一个全新的配方族及其第一个版本。
     * 如果配方名已存在，则会抛出冲突错误。
     * @param tenantId 租户ID
     * @param createRecipeDto 配方数据
     * @returns 创建的配方版本
     */
    async create(tenantId: string, createRecipeDto: CreateRecipeDto) {
        const { name } = createRecipeDto;

        // 检查同名配方是否已存在
        const existingFamily = await this.prisma.recipeFamily.findFirst({
            where: {
                tenantId,
                name,
                deletedAt: null,
            },
        });

        if (existingFamily) {
            throw new ConflictException(`名为 "${name}" 的配方已存在。`);
        }

        // 由于是全新的配方，直接调用内部的创建版本逻辑，但不传入 familyId
        return this.createVersionInternal(tenantId, null, createRecipeDto);
    }

    /**
     * [核心新增] 为一个已存在的配方族创建一个新版本。
     * @param tenantId 租户ID
     * @param familyId 配方族ID
     * @param createRecipeDto 配方数据
     * @returns 创建的配方版本
     */
    async createVersion(tenantId: string, familyId: string, createRecipeDto: CreateRecipeDto) {
        // 确保配方族存在
        const recipeFamily = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId, deletedAt: null },
        });

        if (!recipeFamily) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        // 调用内部的创建版本逻辑，并传入 familyId
        return this.createVersionInternal(tenantId, familyId, createRecipeDto);
    }

    /**
     * [内部方法] 封装了创建配方版本和相关实体的核心逻辑。
     * @param tenantId 租户ID
     * @param familyId 可选的配方族ID。如果提供，则为现有配方创建新版本；否则，创建新配方族。
     * @param createRecipeDto 配方数据
     */
    private async createVersionInternal(tenantId: string, familyId: string | null, createRecipeDto: CreateRecipeDto) {
        // [修复] 从 DTO 中解构 ingredients，而不是 doughs
        const { name, type = 'MAIN', ingredients, products, notes, targetTemp, lossRatio, procedure } = createRecipeDto;

        // [修改] 增加事务隔离级别配置，防止并发导入时产生重复原料
        return this.prisma.$transaction(
            async (tx) => {
                let recipeFamily: RecipeFamilyWithVersions;

                if (familyId) {
                    // 为现有配方族创建新版本
                    const existingFamily = await tx.recipeFamily.findFirst({
                        where: { id: familyId, tenantId },
                        include: { versions: true },
                    });
                    if (!existingFamily) throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
                    recipeFamily = existingFamily;
                } else {
                    // 创建全新的配方族
                    recipeFamily = await tx.recipeFamily.create({
                        data: { name, tenantId, type },
                        include: { versions: true },
                    });
                }

                // [逻辑不变] 自动创建原料
                const allIngredientNames = new Set<string>();
                ingredients.forEach((ing) => allIngredientNames.add(ing.name));
                if (products) {
                    products.forEach((p) => {
                        p.mixIn?.forEach((i) => allIngredientNames.add(i.name));
                        p.fillings?.forEach((i) => allIngredientNames.add(i.name));
                        p.toppings?.forEach((i) => allIngredientNames.add(i.name));
                    });
                }

                for (const ingredientName of allIngredientNames) {
                    const existingIngredient = await tx.ingredient.findFirst({
                        where: { tenantId, name: ingredientName, deletedAt: null },
                    });
                    if (!existingIngredient) {
                        await tx.ingredient.create({
                            data: { tenantId, name: ingredientName, type: 'STANDARD' },
                        });
                    }
                }

                // [核心修改] 检查是否存在已激活的版本
                const hasActiveVersion = recipeFamily.versions.some((v) => v.isActive);

                // [逻辑不变] 确定新版本号
                const nextVersionNumber =
                    recipeFamily.versions.length > 0 ? Math.max(...recipeFamily.versions.map((v) => v.version)) + 1 : 1;

                // [逻辑不变] 创建配方版本
                const recipeVersion = await tx.recipeVersion.create({
                    data: {
                        familyId: recipeFamily.id,
                        version: nextVersionNumber,
                        notes: notes || `版本 ${nextVersionNumber}`,
                        // [核心修改] 只有在没有其他激活版本时，新版本才默认为激活
                        isActive: !hasActiveVersion,
                    },
                });

                // [回滚] 创建一个默认的 Dough 实体来容纳所有 ingredients
                const dough = await tx.dough.create({
                    data: {
                        recipeVersionId: recipeVersion.id,
                        name: name, // 使用配方名作为默认面团名
                        targetTemp: targetTemp,
                        lossRatio: lossRatio,
                        procedure: procedure,
                    },
                });

                // [核心修正] 创建 DoughIngredient 时不再包含 isFlour 和 waterContent
                for (const ingredientDto of ingredients) {
                    const linkedPreDough = await tx.recipeFamily.findFirst({
                        where: { name: ingredientDto.name, tenantId: tenantId, type: 'PRE_DOUGH', deletedAt: null },
                    });
                    await tx.doughIngredient.create({
                        data: {
                            doughId: dough.id,
                            name: ingredientDto.name,
                            ratio: ingredientDto.ratio,
                            linkedPreDoughId: linkedPreDough?.id,
                        },
                    });
                }

                // [逻辑不变] 创建最终产品
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

                        const allProductIngredients = [
                            ...(productDto.mixIn?.map((i) => ({ ...i, type: ProductIngredientType.MIX_IN })) ?? []),
                            ...(productDto.fillings?.map((i) => ({ ...i, type: ProductIngredientType.FILLING })) ?? []),
                            ...(productDto.toppings?.map((i) => ({ ...i, type: ProductIngredientType.TOPPING })) ?? []),
                        ];

                        for (const pIngredientDto of allProductIngredients) {
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
                                    linkedExtraId: linkedExtra?.id,
                                },
                            });
                        }
                    }
                }

                // [逻辑不变] 返回结果
                return tx.recipeVersion.findUnique({
                    where: { id: recipeVersion.id },
                    include: {
                        family: true,
                        doughs: { include: { ingredients: true } },
                        products: { include: { ingredients: true } },
                    },
                });
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
        );
    }

    // [REFACTORED] findAll 方法现在直接计算并返回每个配方的制作总数
    async findAll(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                deletedAt: null,
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: true,
                        doughs: {
                            include: {
                                ingredients: true,
                            },
                        },
                    },
                },
            },
        });

        // [ADDED] 使用 Promise.all 并行计算每个配方的生产总数
        const familiesWithCounts = await Promise.all(
            recipeFamilies.map(async (family) => {
                // 只查找激活的版本来计算
                const activeVersion = family.versions.find((v) => v.isActive);
                if (!activeVersion || activeVersion.products.length === 0) {
                    // 如果没有激活的版本或版本中没有产品，则制作次数为0
                    return { ...family, productionCount: 0 };
                }

                const productIds = activeVersion.products.map((p) => p.id);

                // 在数据库中聚合计算与这些产品相关的已完成任务的总数量
                const result = await this.prisma.productionTaskItem.aggregate({
                    _sum: {
                        quantity: true,
                    },
                    where: {
                        productId: { in: productIds },
                        task: {
                            status: 'COMPLETED', // 只统计已完成的任务
                            deletedAt: null,
                        },
                    },
                });

                // 将计算结果附加到配方对象上
                return {
                    ...family,
                    productionCount: result._sum.quantity || 0,
                };
            }),
        );

        return familiesWithCounts;
    }

    /**
     * 现在返回配方家族及其所有版本，并深度包含所引用的面种配方
     */
    async findOne(familyId: string) {
        const family = await this.prisma.recipeFamily.findFirst({
            where: {
                id: familyId,
                deletedAt: null,
            },
            include: {
                versions: {
                    include: {
                        doughs: {
                            include: {
                                ingredients: {
                                    // 深度查询，如果原料是面种，则把它也查出来
                                    include: {
                                        linkedPreDough: {
                                            include: {
                                                versions: {
                                                    where: { isActive: true },
                                                    include: {
                                                        doughs: {
                                                            include: {
                                                                ingredients: true,
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
     * [核心新增] 激活一个指定的配方版本
     */
    async activateVersion(tenantId: string, familyId: string, versionId: string) {
        // 验证该版本是否存在且属于该租户
        const versionToActivate = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: {
                    tenantId: tenantId,
                },
            },
        });

        if (!versionToActivate) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        // 使用事务确保原子性
        return this.prisma.$transaction(async (tx) => {
            // 1. 将该配方家族下所有版本设为非激活
            await tx.recipeVersion.updateMany({
                where: { familyId: familyId },
                data: { isActive: false },
            });

            // 2. 将指定版本设为激活
            const activatedVersion = await tx.recipeVersion.update({
                where: { id: versionId },
                data: { isActive: true },
            });

            return activatedVersion;
        });
    }

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
