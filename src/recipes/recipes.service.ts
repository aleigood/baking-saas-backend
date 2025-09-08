import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto, DoughIngredientDto } from './dto/create-recipe.dto';
// [核心修复] 在导入语句中加入 Dough 和 DoughIngredient 类型
import {
    Prisma,
    RecipeFamily,
    RecipeVersion,
    ProductIngredientType,
    RecipeType,
    IngredientType,
    Dough,
    DoughIngredient,
} from '@prisma/client';
import { RecipeFormTemplateDto } from './dto/recipe-form-template.dto';
import type { DoughTemplate } from './dto/recipe-form-template.dto';

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

// [核心新增] 为预加载的配方家族定义更精确的类型
type PreloadedRecipeFamily = RecipeFamily & {
    versions: (RecipeVersion & {
        doughs: (Dough & {
            ingredients: DoughIngredient[];
        })[];
    })[];
};

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

    async updateVersion(tenantId: string, familyId: string, versionId: string, updateRecipeDto: CreateRecipeDto) {
        // 1. 验证版本是否存在
        const versionToUpdate = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: { tenantId },
            },
            include: {
                products: true,
            },
        });

        if (!versionToUpdate) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        // 2. [核心改造] 精确检查：仅当配方被“已完成”的任务使用时，才禁止修改
        const productIds = versionToUpdate.products.map((p) => p.id);
        if (productIds.length > 0) {
            const usageCount = await this.prisma.productionTaskItem.count({
                where: {
                    productId: { in: productIds },
                    // 关键：增加对关联任务状态的过滤
                    task: {
                        status: 'COMPLETED',
                    },
                },
            });
            if (usageCount > 0) {
                // [核心改造] 提供更友好、更明确的错误信息
                throw new BadRequestException('此配方版本已在生产任务中使用，无法直接修改。请创建一个新版本。');
            }
        }

        // 3. 执行“先删除旧内容，再创建新内容”的更新操作
        return this.prisma.$transaction(async (tx) => {
            // 3.1 删除所有与此版本关联的产品 (及其原料)
            await tx.productIngredient.deleteMany({
                where: { product: { recipeVersionId: versionId } },
            });
            await tx.product.deleteMany({
                where: { recipeVersionId: versionId },
            });

            // 3.2 删除所有与此版本关联的面团原料和面团
            await tx.doughIngredient.deleteMany({
                where: { dough: { recipeVersionId: versionId } },
            });
            await tx.dough.deleteMany({
                where: { recipeVersionId: versionId },
            });

            // 3.3 [重用逻辑] 复用创建新内容的内部逻辑
            // 注意：这里传入 versionId 而不是 familyId，因为我们是在特定的版本上操作
            return this.recreateVersionContents(tenantId, versionId, updateRecipeDto, tx);
        });
    }

    private async createVersionInternal(tenantId: string, familyId: string | null, createRecipeDto: CreateRecipeDto) {
        const { name, type = 'MAIN' } = createRecipeDto;

        return this.prisma.$transaction(
            async (tx) => {
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

                const hasActiveVersion = recipeFamily.versions.some((v) => v.isActive);
                const nextVersionNumber =
                    recipeFamily.versions.length > 0 ? Math.max(...recipeFamily.versions.map((v) => v.version)) + 1 : 1;

                const recipeVersion = await tx.recipeVersion.create({
                    data: {
                        familyId: recipeFamily.id,
                        version: nextVersionNumber,
                        notes: createRecipeDto.notes || `版本 ${nextVersionNumber}`,
                        isActive: !hasActiveVersion,
                    },
                });

                return this.recreateVersionContents(tenantId, recipeVersion.id, createRecipeDto, tx);
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
        );
    }

    private async recreateVersionContents(
        tenantId: string,
        versionId: string,
        recipeDto: CreateRecipeDto,
        tx: Prisma.TransactionClient,
    ) {
        const { name, type = 'MAIN', ingredients, products, targetTemp, lossRatio, procedure } = recipeDto;

        const ingredientNames = new Set<string>();
        for (const ing of ingredients) {
            if (ingredientNames.has(ing.name)) {
                throw new BadRequestException(`配方中包含重复的原料或面种: "${ing.name}"`);
            }
            ingredientNames.add(ing.name);
        }

        const preDoughFamilies = await this.preloadPreDoughFamilies(tenantId, ingredients, tx);
        this.calculatePreDoughTotalRatio(ingredients, preDoughFamilies);
        this._validateBakerPercentage(type, ingredients);

        const allRawIngredients = [
            ...ingredients,
            ...(products ?? []).flatMap((p) => [...(p.mixIn ?? []), ...(p.fillings ?? []), ...(p.toppings ?? [])]),
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
                const isWater = ing.name === '水';
                existingIngredient = await tx.ingredient.create({
                    data: {
                        tenantId,
                        name: ing.name,
                        type: isWater ? IngredientType.UNTRACKED : IngredientType.STANDARD,
                        isFlour: isWater ? false : 'isFlour' in ing ? (ing.isFlour ?? false) : false,
                        waterContent: isWater ? 1 : 'waterContent' in ing ? (ing.waterContent ?? 0) : 0,
                    },
                });
            }
            ing.ingredientId = existingIngredient.id;
        }

        await tx.recipeVersion.update({
            where: { id: versionId },
            data: { notes: recipeDto.notes },
        });

        const dough = await tx.dough.create({
            data: {
                recipeVersionId: versionId,
                name: name,
                targetTemp: type === 'MAIN' ? targetTemp : undefined,
                lossRatio: lossRatio,
                procedure: procedure,
            },
        });

        for (const ingredientDto of ingredients) {
            const linkedPreDough = preDoughFamilies.get(ingredientDto.name);
            await tx.doughIngredient.create({
                data: {
                    doughId: dough.id,
                    ratio: linkedPreDough ? null : ingredientDto.ratio,
                    flourRatio: ingredientDto.flourRatio,
                    ingredientId: linkedPreDough ? null : ingredientDto.ingredientId,
                    linkedPreDoughId: linkedPreDough?.id,
                },
            });
        }

        if (type === 'MAIN' && products) {
            for (const productDto of products) {
                const product = await tx.product.create({
                    data: {
                        recipeVersionId: versionId,
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
            where: { id: versionId },
            include: {
                family: true,
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
                                linkedExtra: true,
                            },
                        },
                    },
                },
            },
        });
    }

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

    async findProductsForTasks(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                type: 'MAIN',
                deletedAt: null,
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: {
                            orderBy: {
                                name: 'asc',
                            },
                        },
                    },
                },
            },
        });

        const familiesWithProductionCount = await Promise.all(
            recipeFamilies.map(async (family) => {
                const activeVersion = family.versions[0];
                if (!activeVersion || activeVersion.products.length === 0) {
                    return { ...family, productionTaskCount: 0 };
                }

                const productIds = activeVersion.products.map((p) => p.id);

                const taskCount = await this.prisma.productionTaskItem.count({
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
                    productionTaskCount: taskCount,
                };
            }),
        );

        familiesWithProductionCount.sort((a, b) => b.productionTaskCount - a.productionTaskCount);

        const groupedProducts: Record<string, { id: string; name: string }[]> = {};
        familiesWithProductionCount.forEach((family) => {
            const activeVersion = family.versions[0];
            if (activeVersion && activeVersion.products.length > 0) {
                if (!groupedProducts[family.name]) {
                    groupedProducts[family.name] = [];
                }
                activeVersion.products.forEach((product) => {
                    groupedProducts[family.name].push({
                        id: product.id,
                        name: product.name,
                    });
                });
            }
        });

        return groupedProducts;
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
                                        linkedExtra: true,
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

    async getRecipeVersionFormTemplate(
        tenantId: string,
        familyId: string,
        versionId: string,
    ): Promise<RecipeFormTemplateDto> {
        const version = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: { tenantId },
            },
            include: {
                family: true,
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
                                                        ingredients: { include: { ingredient: true } },
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
                                linkedExtra: true,
                            },
                        },
                    },
                },
            },
        });

        if (!version) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        if (version.family.type === 'PRE_DOUGH' || version.family.type === 'EXTRA') {
            const doughSource = version.doughs[0];
            if (!doughSource) {
                throw new NotFoundException('源配方数据不完整: 缺少面团');
            }

            return {
                name: version.family.name,
                type: version.family.type,
                // [核心改造] 将源版本的 notes 传递给模板
                notes: version.notes || '',
                ingredients: doughSource.ingredients
                    .filter((ing) => ing.ingredient && ing.ratio !== null)
                    .map((ing) => ({
                        id: ing.ingredient!.id,
                        name: ing.ingredient!.name,
                        ratio: new Prisma.Decimal(ing.ratio!).mul(100).toNumber(),
                    })),
                procedure: doughSource.procedure || [],
            };
        }

        const mainDoughSource = version.doughs.find((d) => d.name === version.family.name);
        if (!mainDoughSource) {
            throw new NotFoundException('源配方数据不完整: 缺少主面团');
        }

        const mainDoughIngredientsForForm: { id: string | null; name: string; ratio: number | null }[] = [];
        const preDoughObjectsForForm: DoughTemplate[] = [];

        for (const ing of mainDoughSource.ingredients) {
            if (ing.linkedPreDough) {
                const preDoughFamily = ing.linkedPreDough;
                const preDoughActiveVersion = preDoughFamily.versions.find((v) => v.isActive);
                const preDoughRecipe = preDoughActiveVersion?.doughs?.[0];

                if (preDoughRecipe) {
                    const flourRatioInMainDough = ing.flourRatio
                        ? new Prisma.Decimal(ing.flourRatio)
                        : new Prisma.Decimal(0);

                    const ingredientsForTemplate = preDoughRecipe.ingredients
                        .filter((i) => i.ingredient !== null && i.ratio !== null)
                        .map((i) => ({
                            id: i.ingredient!.id,
                            name: i.ingredient!.name,
                            ratio: flourRatioInMainDough.mul(i.ratio!).mul(100).toNumber(),
                        }));

                    preDoughObjectsForForm.push({
                        id: preDoughFamily.id,
                        name: preDoughFamily.name,
                        type: 'PRE_DOUGH',
                        flourRatioInMainDough: flourRatioInMainDough.mul(100).toNumber(),
                        ingredients: ingredientsForTemplate,
                        procedure: preDoughRecipe.procedure,
                    });
                }
            } else if (ing.ingredient && ing.ratio) {
                mainDoughIngredientsForForm.push({
                    id: ing.ingredient.id,
                    name: ing.ingredient.name,
                    ratio: new Prisma.Decimal(ing.ratio).mul(100).toNumber(),
                });
            }
        }

        const mainDoughObjectForForm: DoughTemplate = {
            id: `main_${Date.now()}`,
            name: '主面团',
            type: 'MAIN_DOUGH' as const,
            lossRatio: mainDoughSource.lossRatio
                ? new Prisma.Decimal(mainDoughSource.lossRatio).mul(100).toNumber()
                : 0,
            ingredients: mainDoughIngredientsForForm,
            procedure: mainDoughSource.procedure || [],
        };

        const formTemplate: RecipeFormTemplateDto = {
            name: version.family.name,
            type: 'MAIN',
            // [核心改造] 将源版本的 notes 传递给模板
            notes: version.notes || '',
            doughs: [mainDoughObjectForForm, ...preDoughObjectsForForm],
            products: version.products.map((p) => {
                const processIngredients = (type: ProductIngredientType) => {
                    return p.ingredients
                        .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                        .map((ing) => ({
                            id: ing.ingredient?.id || ing.linkedExtra?.id || null,
                            name: ing.ingredient?.name || ing.linkedExtra?.name || '', // [修改] 在此处添加 name 字段
                            ratio: ing.ratio ? new Prisma.Decimal(ing.ratio).mul(100).toNumber() : null,
                            weightInGrams: ing.weightInGrams,
                        }));
                };
                return {
                    name: p.name,
                    baseDoughWeight: p.baseDoughWeight,
                    mixIns: processIngredients(ProductIngredientType.MIX_IN),
                    fillings: processIngredients(ProductIngredientType.FILLING),
                    toppings: processIngredients(ProductIngredientType.TOPPING),
                    procedure: p.procedure || [],
                };
            }),
        };

        return formTemplate;
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

    private async preloadPreDoughFamilies(
        tenantId: string,
        ingredients: DoughIngredientDto[],
        tx: Prisma.TransactionClient,
    ): Promise<Map<string, PreloadedRecipeFamily>> {
        const preDoughNames = ingredients
            .filter((ing) => ing.flourRatio !== undefined && ing.flourRatio !== null)
            .map((ing) => ing.name);

        if (preDoughNames.length === 0) {
            return new Map();
        }

        const families = await tx.recipeFamily.findMany({
            where: {
                name: { in: preDoughNames },
                tenantId,
                type: 'PRE_DOUGH',
                deletedAt: null,
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: { doughs: { include: { ingredients: true } } },
                },
            },
        });

        return new Map(families.map((f) => [f.name, f as PreloadedRecipeFamily]));
    }

    private calculatePreDoughTotalRatio(
        ingredients: DoughIngredientDto[],
        preDoughFamilies: Map<string, PreloadedRecipeFamily>,
    ) {
        for (const ing of ingredients) {
            if (ing.flourRatio !== undefined && ing.flourRatio !== null) {
                const preDoughFamily = preDoughFamilies.get(ing.name);
                const preDoughRecipe = preDoughFamily?.versions[0]?.doughs[0];

                if (!preDoughRecipe) {
                    throw new BadRequestException(`名为 "${ing.name}" 的预制面团配方不存在或未激活。`);
                }

                const preDoughTotalRatioSum = preDoughRecipe.ingredients.reduce((sum, i) => sum + (i.ratio ?? 0), 0);

                if (preDoughTotalRatioSum > 0) {
                    ing.ratio = ing.flourRatio * preDoughTotalRatioSum;
                } else {
                    ing.ratio = 0;
                }
            }
        }
    }

    private _validateBakerPercentage(type: RecipeType, ingredients: DoughIngredientDto[]) {
        if (type === 'EXTRA') {
            return;
        }

        let totalFlourRatio = 0;

        for (const ingredientDto of ingredients) {
            if (ingredientDto.flourRatio !== undefined && ingredientDto.flourRatio !== null) {
                totalFlourRatio += ingredientDto.flourRatio;
            } else if (ingredientDto.isFlour) {
                totalFlourRatio += ingredientDto.ratio ?? 0;
            }
        }

        if (Math.abs(totalFlourRatio - 1) > 0.001) {
            throw new BadRequestException(
                `配方验证失败：所有面粉类原料（包括用于制作预制面团的面粉）的比例总和必须为100%。当前计算总和为: ${(
                    totalFlourRatio * 100
                ).toFixed(2)}%`,
            );
        }
    }
}
