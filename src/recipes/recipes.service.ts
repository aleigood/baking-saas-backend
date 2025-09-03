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

    private async createVersionInternal(tenantId: string, familyId: string | null, createRecipeDto: CreateRecipeDto) {
        const { name, type = 'MAIN', ingredients, products, notes, targetTemp, lossRatio, procedure } = createRecipeDto;

        // [核心新增] 新增校验，防止配方中出现重复的原料或面种
        const ingredientNames = new Set<string>();
        for (const ing of ingredients) {
            if (ingredientNames.has(ing.name)) {
                throw new BadRequestException(`配方中包含重复的原料或面种: "${ing.name}"`);
            }
            ingredientNames.add(ing.name);
        }

        return this.prisma.$transaction(
            async (tx) => {
                // [核心修改] 在事务开始时就预加载所有需要的预制面团信息
                const preDoughFamilies = await this.preloadPreDoughFamilies(tenantId, ingredients, tx);

                // [核心修改] 在创建之前，根据前端传入的意图（flourRatio）计算出预制面团的总重比例（ratio）
                this.calculatePreDoughTotalRatio(ingredients, preDoughFamilies);

                this._validateBakerPercentage(type, ingredients);

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
                        // [核心修改] 只有主配方(MAIN)才记录目标温度，其他类型配方忽略此字段
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
                            // [核心修改] 对于预制面团，ratio 显式存为 null，因为它将动态计算。
                            // 普通原料则正常存储其 ratio。
                            ratio: linkedPreDough ? null : ingredientDto.ratio,
                            // [核心修改] flourRatio 存储的是用户的原始意图比例
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

                // [核心重构] 在创建成功后，返回一个与 findOne 方法结构一致的、包含所有嵌套信息的完整对象
                return tx.recipeVersion.findUnique({
                    where: { id: recipeVersion.id },
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
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
        );
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
            orderBy: {
                name: 'asc',
            },
        });

        const groupedProducts: Record<string, { id: string; name: string }[]> = {};
        recipeFamilies.forEach((family) => {
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
                notes: '',
                ingredients: doughSource.ingredients
                    .filter((ing) => ing.ingredient && ing.ratio !== null)
                    .map((ing) => ({
                        id: ing.ingredient!.id,
                        name: ing.ingredient!.name,
                        // [核心重构] 全面采用Prisma.Decimal保证精度
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
                    // [核心重构] 直接使用flourRatio，这是用户的原始意图，避免任何不准确的转换
                    const flourRatioInMainDough = ing.flourRatio
                        ? new Prisma.Decimal(ing.flourRatio)
                        : new Prisma.Decimal(0);

                    // 这里的计算仅用于在UI上展示预估的百分比，不影响核心逻辑
                    const ingredientsForTemplate = preDoughRecipe.ingredients
                        .filter((i) => i.ingredient !== null && i.ratio !== null)
                        .map((i) => ({
                            id: i.ingredient!.id,
                            name: i.ingredient!.name,
                            // [核心重构] 全面采用Prisma.Decimal保证精度
                            ratio: flourRatioInMainDough.mul(i.ratio!).mul(100).toNumber(),
                        }));

                    preDoughObjectsForForm.push({
                        id: preDoughFamily.id,
                        name: preDoughFamily.name,
                        type: 'PRE_DOUGH',
                        // [核心重构] 直接返回存储的flourRatio
                        flourRatioInMainDough: flourRatioInMainDough.mul(100).toNumber(),
                        ingredients: ingredientsForTemplate,
                        procedure: preDoughRecipe.procedure,
                    });
                }
            } else if (ing.ingredient && ing.ratio) {
                mainDoughIngredientsForForm.push({
                    id: ing.ingredient.id,
                    name: ing.ingredient.name,
                    // [核心重构] 全面采用Prisma.Decimal保证精度
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
            notes: '',
            doughs: [mainDoughObjectForForm, ...preDoughObjectsForForm],
            products: version.products.map((p) => {
                const processIngredients = (type: ProductIngredientType) => {
                    return p.ingredients
                        .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                        .map((ing) => ({
                            id: ing.ingredient?.id || ing.linkedExtra?.id || null,
                            // [核心重构] 全面采用Prisma.Decimal保证精度
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

    // [核心新增] 辅助函数：预加载所有需要的预制面团信息
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

    // [核心修改] 此函数现在仅用于为普通原料计算ratio，预制面团的ratio将不再预先计算和存储。
    private calculatePreDoughTotalRatio(
        ingredients: DoughIngredientDto[],
        preDoughFamilies: Map<string, PreloadedRecipeFamily>,
    ) {
        for (const ing of ingredients) {
            // 这个`if`块的逻辑现在只在创建时临时计算总重比，用于烘焙师百分比的验证，
            // 但计算出的`ratio`将不再保存到数据库中（如`createVersionInternal`中的修改所示）。
            if (ing.flourRatio !== undefined && ing.flourRatio !== null) {
                const preDoughFamily = preDoughFamilies.get(ing.name);
                const preDoughRecipe = preDoughFamily?.versions[0]?.doughs[0];

                if (!preDoughRecipe) {
                    throw new BadRequestException(`名为 "${ing.name}" 的预制面团配方不存在或未激活。`);
                }

                const preDoughTotalRatioSum = preDoughRecipe.ingredients.reduce((sum, i) => sum + (i.ratio ?? 0), 0);

                if (preDoughTotalRatioSum > 0) {
                    // 临时计算总重比例，仅用于验证，不用于存储
                    ing.ratio = ing.flourRatio * preDoughTotalRatioSum;
                } else {
                    ing.ratio = 0;
                }
            }
        }
    }

    // [核心修复] 移除了 async 和未使用的参数
    private _validateBakerPercentage(type: RecipeType, ingredients: DoughIngredientDto[]) {
        if (type === 'EXTRA') {
            return;
        }

        let totalFlourRatio = 0;

        for (const ingredientDto of ingredients) {
            // [核心修改] 如果是预制面团，直接使用 flourRatio
            if (ingredientDto.flourRatio !== undefined && ingredientDto.flourRatio !== null) {
                totalFlourRatio += ingredientDto.flourRatio;
            }
            // [核心修改] 如果是普通面粉原料，使用 ratio
            else if (ingredientDto.isFlour) {
                totalFlourRatio += ingredientDto.ratio ?? 0;
            }
        }

        // [核心修改] 校验总和是否接近 1 (100%)
        if (Math.abs(totalFlourRatio - 1) > 0.001) {
            throw new BadRequestException(
                `配方验证失败：所有面粉类原料（包括用于制作预制面团的面粉）的比例总和必须为100%。当前计算总和为: ${(
                    totalFlourRatio * 100
                ).toFixed(2)}%`,
            );
        }
    }
}
