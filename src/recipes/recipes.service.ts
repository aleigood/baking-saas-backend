import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto, DoughIngredientDto } from './dto/create-recipe.dto';
import { Prisma, RecipeFamily, RecipeVersion, ProductIngredientType, RecipeType, IngredientType } from '@prisma/client'; // [修改] 导入IngredientType
// [核心新增] 导入新的 DTO
import { RecipeFormTemplateDto } from './dto/recipe-form-template.dto';

// [核心修复] 从 DTO 中导入 DoughTemplate 类型以供内部使用
import type { DoughTemplate } from './dto/recipe-form-template.dto';

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

    async findProductsForTasks(tenantId: string) {
        // 查找所有未停用的主面团配方
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                type: 'MAIN',
                deletedAt: null,
            },
            include: {
                // 只加载激活的配方版本
                versions: {
                    where: { isActive: true },
                    // 加载版本下的所有产品
                    include: {
                        products: {
                            orderBy: {
                                name: 'asc', // 按产品名称排序
                            },
                        },
                    },
                },
            },
            orderBy: {
                name: 'asc', // 按配方名称排序
            },
        });

        // 将扁平的产品列表按配方名称（类型）进行分组
        const groupedProducts: Record<string, { id: string; name: string }[]> = {};
        recipeFamilies.forEach((family) => {
            const activeVersion = family.versions[0];
            if (activeVersion && activeVersion.products.length > 0) {
                // 使用配方名称作为分组的 key
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

    // [核心新增] 新增方法，用于从现有版本生成表单模板
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

        const mainDoughSource = version.doughs.find((d) => d.name === version.family.name);
        if (!mainDoughSource) {
            throw new NotFoundException('源配方数据不完整: 缺少主面团');
        }

        // [核心修复] 明确数组类型，解决 'never[]' 错误
        const mainDoughIngredientsForForm: { id: string | null; name: string; ratio: number | null }[] = [];
        // [核心修复] 明确数组类型，解决 'any[]' 和不安全分配的错误
        const preDoughObjectsForForm: DoughTemplate[] = [];

        for (const ing of mainDoughSource.ingredients) {
            if (ing.linkedPreDough) {
                const preDoughFamily = ing.linkedPreDough;
                const preDoughActiveVersion = preDoughFamily.versions.find((v) => v.isActive);
                const preDoughRecipe = preDoughActiveVersion?.doughs?.[0];

                if (preDoughRecipe) {
                    const preDoughTotalRatio = preDoughRecipe.ingredients.reduce((sum, i) => sum + i.ratio, 0);
                    const preDoughFlourRatioInPreDough = preDoughRecipe.ingredients
                        .filter((i) => i.ingredient?.isFlour)
                        .reduce((sum, i) => sum + i.ratio, 0);

                    const conversionFactor =
                        preDoughTotalRatio > 0
                            ? new Prisma.Decimal(ing.ratio).div(preDoughTotalRatio)
                            : new Prisma.Decimal(0);
                    const effectiveFlourRatio = new Prisma.Decimal(preDoughFlourRatioInPreDough).mul(conversionFactor);

                    const ingredientsForTemplate = preDoughRecipe.ingredients
                        .filter((i) => i.ingredient !== null)
                        .map((i) => ({
                            id: i.ingredient!.id,
                            name: i.ingredient!.name,
                            ratio: new Prisma.Decimal(i.ratio).mul(conversionFactor).mul(100).toNumber(),
                        }));

                    preDoughObjectsForForm.push({
                        id: preDoughFamily.id,
                        name: preDoughFamily.name,
                        type: 'PRE_DOUGH',
                        flourRatioInMainDough: effectiveFlourRatio.mul(100).toNumber(),
                        ingredients: ingredientsForTemplate,
                        procedure: preDoughRecipe.procedure,
                    });
                }
            } else if (ing.ingredient) {
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
            notes: '', // 新版本备注为空
            doughs: [mainDoughObjectForForm, ...preDoughObjectsForForm],
            products: version.products.map((p) => {
                const processIngredients = (type: ProductIngredientType) => {
                    return p.ingredients
                        .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                        .map((ing) => ({
                            id: ing.ingredient?.id || ing.linkedExtra?.id || null,
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
