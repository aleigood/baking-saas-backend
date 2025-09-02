import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto, DoughIngredientDto } from './dto/create-recipe.dto';
import { Prisma, RecipeFamily, RecipeVersion, ProductIngredientType, RecipeType, IngredientType } from '@prisma/client'; // [修改] 导入IngredientType

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

@Injectable()
export class RecipesService {
    constructor(private prisma: PrismaService) {}

    async create(tenantId: string, createRecipeDto: CreateRecipeDto) {
        const { name } = createRecipeDto;

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

        return this.createVersionInternal(tenantId, null, createRecipeDto);
    }

    async createVersion(tenantId: string, familyId: string, createRecipeDto: CreateRecipeDto) {
        const recipeFamily = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId, deletedAt: null },
        });

        if (!recipeFamily) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        return this.createVersionInternal(tenantId, familyId, createRecipeDto);
    }

    private async createVersionInternal(tenantId: string, familyId: string | null, createRecipeDto: CreateRecipeDto) {
        const { name, type = 'MAIN', ingredients, products, notes, targetTemp, lossRatio, procedure } = createRecipeDto;

        return this.prisma.$transaction(
            async (tx) => {
                await this._validateBakerPercentage(type, ingredients, tenantId, tx);

                let recipeFamily: RecipeFamilyWithVersions;

                if (familyId) {
                    const existingFamily = await tx.recipeFamily.findFirst({
                        where: { id: familyId, tenantId },
                        include: { versions: true },
                    });
                    if (!existingFamily) throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
                    recipeFamily = existingFamily;
                } else {
                    recipeFamily = await tx.recipeFamily.create({
                        data: { name, tenantId, type },
                        include: { versions: true },
                    });
                }

                const allRawIngredients = [
                    ...ingredients,
                    ...(products ?? []).flatMap((p) => [
                        ...(p.mixIn ?? []),
                        ...(p.fillings ?? []),
                        ...(p.toppings ?? []),
                    ]),
                ];

                for (const ing of allRawIngredients) {
                    if (ing.ingredientId) continue;

                    const isPreDoughOrExtra = await tx.recipeFamily.findFirst({
                        where: { name: ing.name, tenantId, type: { in: ['PRE_DOUGH', 'EXTRA'] } },
                    });
                    if (isPreDoughOrExtra) continue;

                    let existingIngredient = await tx.ingredient.findFirst({
                        where: { tenantId, name: ing.name, deletedAt: null },
                    });

                    if (!existingIngredient) {
                        // [核心修改] 新增对"水"的特殊处理逻辑
                        const isWater = ing.name === '水';
                        existingIngredient = await tx.ingredient.create({
                            data: {
                                tenantId,
                                name: ing.name,
                                // 如果是“水”，则类型为UNTRACKED，否则为STANDARD
                                type: isWater ? IngredientType.UNTRACKED : IngredientType.STANDARD,
                                // 如果是“水”，则不是面粉
                                isFlour: isWater ? false : 'isFlour' in ing ? (ing.isFlour ?? false) : false,
                                // [核心修改] waterContent 现在统一使用小数, 1 代表 100%
                                waterContent: isWater ? 1 : 'waterContent' in ing ? (ing.waterContent ?? 0) : 0,
                            },
                        });
                    }
                    ing.ingredientId = existingIngredient.id;
                }

                const hasActiveVersion = recipeFamily.versions.some((v) => v.isActive);
                const nextVersionNumber =
                    recipeFamily.versions.length > 0 ? Math.max(...recipeFamily.versions.map((v) => v.version)) + 1 : 1;

                const recipeVersion = await tx.recipeVersion.create({
                    data: {
                        familyId: recipeFamily.id,
                        version: nextVersionNumber,
                        notes: notes || `版本 ${nextVersionNumber}`,
                        isActive: !hasActiveVersion,
                    },
                });

                const dough = await tx.dough.create({
                    data: {
                        recipeVersionId: recipeVersion.id,
                        name: name,
                        targetTemp: targetTemp,
                        lossRatio: lossRatio,
                        procedure: procedure,
                    },
                });

                for (const ingredientDto of ingredients) {
                    const linkedPreDough = await tx.recipeFamily.findFirst({
                        where: { name: ingredientDto.name, tenantId: tenantId, type: 'PRE_DOUGH', deletedAt: null },
                    });
                    await tx.doughIngredient.create({
                        data: {
                            doughId: dough.id,
                            ratio: ingredientDto.ratio,
                            ingredientId: linkedPreDough ? null : ingredientDto.ingredientId,
                            linkedPreDoughId: linkedPreDough?.id,
                        },
                    });
                }

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
                                    type: pIngredientDto.type,
                                    ratio: pIngredientDto.ratio,
                                    weightInGrams: pIngredientDto.weightInGrams,
                                    ingredientId: linkedExtra ? null : pIngredientDto.ingredientId,
                                    linkedExtraId: linkedExtra?.id,
                                },
                            });
                        }
                    }
                }

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

    // [核心重构] 修改 findAll 方法，使其返回分类、排序和聚合后的数据
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
                const productCount = activeVersion?.products?.length || 0;
                const ingredientCount =
                    activeVersion?.doughs.reduce((sum, dough) => sum + (dough._count?.ingredients || 0), 0) || 0;

                // 制作次数的计算逻辑保持不变
                if (!activeVersion || activeVersion.products.length === 0) {
                    return { ...family, productCount, ingredientCount, productionTaskCount: 0 };
                }

                const productIds = activeVersion.products.map((p) => p.id);

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
                    productCount,
                    ingredientCount,
                    productionTaskCount: distinctTasks.length,
                };
            }),
        );

        // 在服务端进行分类和排序
        const mainRecipes = familiesWithCounts
            .filter((family) => family.type === 'MAIN')
            .sort((a, b) => (b.productionTaskCount || 0) - (a.productionTaskCount || 0));

        const otherRecipes = familiesWithCounts
            .filter((family) => family.type === 'PRE_DOUGH' || family.type === 'EXTRA')
            .sort((a, b) => a.name.localeCompare(b.name));

        return {
            mainRecipes,
            otherRecipes,
        };
    }

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
                                        ingredient: true,
                                        linkedPreDough: {
                                            include: {
                                                versions: {
                                                    where: { isActive: true },
                                                    include: {
                                                        doughs: {
                                                            include: {
                                                                ingredients: {
                                                                    include: {
                                                                        ingredient: true,
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
                        products: {
                            include: {
                                ingredients: {
                                    include: {
                                        ingredient: true,
                                        linkedExtra: true, // [核心修复] 确保在查询产品时，能一并返回其关联的“附加配方”（如馅料）
                                    },
                                },
                            },
                        },
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

    async activateVersion(tenantId: string, familyId: string, versionId: string) {
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

        return this.prisma.$transaction(async (tx) => {
            await tx.recipeVersion.updateMany({
                where: { familyId: familyId },
                data: { isActive: false },
            });

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

        const productIds = family.versions.flatMap((version) => version.products.map((product) => product.id));

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

        return this.prisma.recipeFamily.delete({
            where: { id: familyId },
        });
    }

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

    async restore(familyId: string) {
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

    async deleteVersion(tenantId: string, familyId: string, versionId: string) {
        const versionToDelete = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: {
                    tenantId: tenantId,
                },
            },
            include: {
                products: true,
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

        if (versionToDelete.isActive) {
            throw new BadRequestException('不能删除当前激活的配方版本');
        }

        if (versionToDelete.family._count.versions <= 1) {
            throw new BadRequestException('不能删除配方族的最后一个版本');
        }

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

        return this.prisma.recipeVersion.delete({
            where: { id: versionId },
        });
    }

    private async _validateBakerPercentage(
        type: RecipeType,
        ingredients: DoughIngredientDto[],
        tenantId: string,
        tx: Prisma.TransactionClient,
    ) {
        if (type === 'EXTRA') {
            return;
        }

        let totalFlourRatio = 0;

        for (const ingredientDto of ingredients) {
            if (ingredientDto.isFlour) {
                totalFlourRatio += ingredientDto.ratio;
            } else {
                // [核心修改] 检查是否为预制面团
                const preDoughFamily = await tx.recipeFamily.findFirst({
                    where: {
                        name: ingredientDto.name, // 预制面团仍然通过名称关联
                        tenantId,
                        type: 'PRE_DOUGH',
                        deletedAt: null,
                    },
                    include: {
                        versions: {
                            where: { isActive: true },
                            include: {
                                doughs: {
                                    include: {
                                        ingredients: {
                                            include: {
                                                ingredient: true, // 深度查询以获取isFlour属性
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                });

                if (preDoughFamily && preDoughFamily.versions.length > 0) {
                    const preDoughVersion = preDoughFamily.versions[0];
                    const preDough = preDoughVersion.doughs[0];

                    if (preDough) {
                        const preDoughTotalRatio = preDough.ingredients.reduce((sum, ing) => sum + ing.ratio, 0);

                        // [核心修改] 直接从查询结果中计算面粉总量
                        const preDoughFlourRatio = preDough.ingredients
                            .filter((ing) => ing.ingredient?.isFlour)
                            .reduce((sum, ing) => sum + ing.ratio, 0);

                        if (preDoughTotalRatio > 0) {
                            const effectiveFlourRatio = (ingredientDto.ratio / preDoughTotalRatio) * preDoughFlourRatio;
                            totalFlourRatio += effectiveFlourRatio;
                        }
                    }
                }
            }
        }

        // [核心修改] 验证逻辑更新为基于小数(1代表100%)
        if (Math.abs(totalFlourRatio - 1) > 0.001) {
            throw new BadRequestException(
                `配方验证失败：所有面粉类原料（包括预制面团中折算的面粉）的比率总和必须为100%。当前计算总和为: ${(
                    totalFlourRatio * 100
                ).toFixed(2)}%`,
            );
        }
    }
}
