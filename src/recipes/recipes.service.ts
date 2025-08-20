import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
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

                // [核心修正] 统一收集所有原料名称，并从DoughIngredient中获取isFlour等属性
                const allIngredientNames = new Set<string>();
                ingredients.forEach((ing) => allIngredientNames.add(ing.name));
                if (products) {
                    products.forEach((p) => {
                        (p.mixIn ?? []).forEach((ing) => allIngredientNames.add(ing.name));
                        (p.fillings ?? []).forEach((ing) => allIngredientNames.add(ing.name));
                        (p.toppings ?? []).forEach((ing) => allIngredientNames.add(ing.name));
                    });
                }

                // 创建一个从原料名称到其详细DTO的映射，以便获取isFlour等信息
                const doughIngredientMap = new Map(ingredients.map((item) => [item.name, item]));

                for (const ingredientName of allIngredientNames) {
                    const existingIngredient = await tx.ingredient.findFirst({
                        where: { tenantId, name: ingredientName, deletedAt: null },
                    });

                    if (!existingIngredient) {
                        // 从映射中查找该原料的详细信息
                        const ingredientDetails = doughIngredientMap.get(ingredientName);
                        await tx.ingredient.create({
                            data: {
                                tenantId,
                                name: ingredientName,
                                type: 'STANDARD',
                                // 如果在DoughIngredient中找到了定义，则使用，否则默认为false/0
                                isFlour: ingredientDetails?.isFlour ?? false,
                                waterContent: ingredientDetails?.waterContent ?? 0,
                            },
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

    /**
     * [V2.5 核心修改] findAll 方法现在返回所有配方（包括已停用的）
     * 客户端可以通过检查 `deletedAt` 字段来判断状态
     */
    async findAll(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: true,
                        doughs: {
                            include: {
                                _count: {
                                    select: { ingredients: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        const familiesWithCounts = await Promise.all(
            recipeFamilies.map(async (family) => {
                const activeVersion = family.versions.find((v) => v.isActive);
                if (!activeVersion || activeVersion.products.length === 0) {
                    return { ...family, productionCount: 0, productionTaskCount: 0 };
                }

                const productIds = activeVersion.products.map((p) => p.id);

                const aggregateResult = await this.prisma.productionTaskItem.aggregate({
                    _sum: {
                        quantity: true,
                    },
                    where: {
                        productId: { in: productIds },
                        task: {
                            status: 'COMPLETED',
                            deletedAt: null,
                        },
                    },
                });

                const distinctTasks = await this.prisma.productionTaskItem.groupBy({
                    by: ['taskId'],
                    where: {
                        productId: { in: productIds },
                        task: {
                            status: 'COMPLETED',
                            deletedAt: null,
                        },
                    },
                });

                return {
                    ...family,
                    productionCount: aggregateResult._sum.quantity || 0,
                    productionTaskCount: distinctTasks.length,
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
            },
            include: {
                versions: {
                    include: {
                        doughs: {
                            include: {
                                ingredients: {
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

    /**
     * [V2.5 核心逻辑重写] 物理删除配方族，增加使用校验
     * @param familyId 配方族ID
     */
    async remove(familyId: string) {
        // 1. 查找配方族及其所有版本和产品
        const family = await this.prisma.recipeFamily.findUnique({
            where: { id: familyId },
            include: {
                versions: {
                    include: {
                        products: true,
                    },
                },
            },
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        // 2. 收集该配方族下所有产品的ID
        const productIds = family.versions.flatMap((version) => version.products.map((product) => product.id));

        // 3. 检查这些产品是否在任何生产任务中使用过
        if (productIds.length > 0) {
            const taskCount = await this.prisma.productionTaskItem.count({
                where: {
                    productId: {
                        in: productIds,
                    },
                },
            });

            if (taskCount > 0) {
                throw new BadRequestException('该配方已被生产任务使用，无法删除。');
            }
        }

        // 4. 执行物理删除
        return this.prisma.recipeFamily.delete({
            where: { id: familyId },
        });
    }

    /**
     * [V2.5 新增] 弃用一个配方 (软删除)
     * @param familyId 配方族ID
     */
    async discontinue(familyId: string) {
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

    /**
     * [V2.5 新增] 恢复一个已弃用的配方
     * @param familyId 配方族ID
     */
    async restore(familyId: string) {
        // 检查配方是否存在（即使是软删除的）
        const family = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId },
            select: { id: true, deletedAt: true },
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        if (family.deletedAt === null) {
            throw new BadRequestException('该配方未被弃用，无需恢复。');
        }

        return this.prisma.recipeFamily.update({
            where: { id: familyId },
            data: { deletedAt: null },
        });
    }

    /**
     * [新增] 删除一个指定的配方版本
     * @param tenantId 租户ID
     * @param familyId 配方族ID
     * @param versionId 要删除的版本ID
     */
    async deleteVersion(tenantId: string, familyId: string, versionId: string) {
        // 1. 验证版本是否存在且属于该租户
        const versionToDelete = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: {
                    tenantId: tenantId,
                },
            },
            include: {
                products: true, // 包含版本下的所有产品
                family: {
                    include: {
                        _count: {
                            select: { versions: true },
                        },
                    },
                },
            },
        });

        if (!versionToDelete) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        // 2. 业务规则：如果是激活的版本，则不允许删除
        if (versionToDelete.isActive) {
            throw new BadRequestException('不能删除当前激活的配方版本');
        }

        // 3. 业务规则：如果这是配方族中唯一的一个版本，则不允许删除
        if (versionToDelete.family._count.versions <= 1) {
            throw new BadRequestException('不能删除配方族的最后一个版本');
        }

        // [错误修复] 检查此版本下的产品是否已在生产任务中使用
        const productIds = versionToDelete.products.map((p) => p.id);
        if (productIds.length > 0) {
            const taskCount = await this.prisma.productionTaskItem.count({
                where: {
                    productId: {
                        in: productIds,
                    },
                },
            });

            if (taskCount > 0) {
                throw new BadRequestException('该配方版本已被生产任务使用，无法删除');
            }
        }

        // 4. 执行删除
        // 由于数据库模型中设置了级联删除（onDelete: Cascade），
        // 删除版本会自动删除其下的Dough、DoughIngredient、Product和ProductIngredient
        return this.prisma.recipeVersion.delete({
            where: { id: versionId },
        });
    }
}
