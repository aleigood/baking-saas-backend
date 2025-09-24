import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto, ComponentIngredientDto, ProductDto } from './dto/create-recipe.dto';
import {
    Prisma,
    RecipeFamily,
    RecipeVersion,
    ProductIngredientType,
    RecipeType,
    IngredientType,
    RecipeComponent,
    ComponentIngredient,
    Product,
    RecipeCategory,
} from '@prisma/client';
import { RecipeFormTemplateDto, ComponentTemplate } from './dto/recipe-form-template.dto';

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

type PreloadedRecipeFamily = RecipeFamily & {
    versions: (RecipeVersion & {
        components: (RecipeComponent & {
            ingredients: ComponentIngredient[];
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

        const productIds = versionToUpdate.products.map((p) => p.id);
        if (productIds.length > 0) {
            const usageCount = await this.prisma.productionTaskItem.count({
                where: {
                    productId: { in: productIds },
                    task: {
                        status: 'COMPLETED',
                    },
                },
            });
            if (usageCount > 0) {
                throw new BadRequestException('此配方版本已在生产任务中使用，无法直接修改。请创建一个新版本。');
            }
        }

        return this.prisma.$transaction(async (tx) => {
            const {
                ingredients,
                products,
                targetTemp,
                lossRatio,
                procedure,
                name,
                type = 'MAIN',
                category,
            } = updateRecipeDto;

            await tx.componentIngredient.deleteMany({
                where: { component: { recipeVersionId: versionId } },
            });
            await tx.recipeComponent.deleteMany({
                where: { recipeVersionId: versionId },
            });

            const ingredientNames = new Set<string>();
            for (const ing of ingredients) {
                if (ingredientNames.has(ing.name)) {
                    throw new BadRequestException(`配方中包含重复的原料或面种: "${ing.name}"`);
                }
                ingredientNames.add(ing.name);
            }
            await this._ensureIngredientsExist(tenantId, updateRecipeDto, tx);

            const preDoughFamilies = await this.preloadPreDoughFamilies(tenantId, ingredients, tx);
            this.calculatePreDoughTotalRatio(ingredients, preDoughFamilies);

            this._validateBakerPercentage(type, category, ingredients);

            const component = await tx.recipeComponent.create({
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

                const ratioForDb =
                    linkedPreDough || ingredientDto.ratio === null || ingredientDto.ratio === undefined
                        ? null
                        : new Prisma.Decimal(ingredientDto.ratio);

                const flourRatioForDb =
                    ingredientDto.flourRatio === null || ingredientDto.flourRatio === undefined
                        ? null
                        : new Prisma.Decimal(ingredientDto.flourRatio);

                await tx.componentIngredient.create({
                    data: {
                        componentId: component.id,
                        ratio: ratioForDb,
                        flourRatio: flourRatioForDb,
                        ingredientId: linkedPreDough ? null : ingredientDto.ingredientId,
                        linkedPreDoughId: linkedPreDough?.id,
                    },
                });
            }

            await this._syncProductsForVersion(tenantId, versionId, versionToUpdate.products, products || [], tx);

            await tx.recipeVersion.update({
                where: { id: versionId },
                data: { notes: updateRecipeDto.notes },
            });

            return this.prisma.recipeVersion.findUnique({
                where: { id: versionId },
                include: {
                    family: true,
                    components: {
                        include: {
                            ingredients: { include: { ingredient: true, linkedPreDough: true } },
                        },
                    },
                    products: {
                        include: {
                            ingredients: { include: { ingredient: true, linkedExtra: true } },
                        },
                    },
                },
            });
        });
    }

    private async _syncProductsForVersion(
        tenantId: string,
        versionId: string,
        existingProducts: Product[],
        newProductsDto: ProductDto[],
        tx: Prisma.TransactionClient,
    ) {
        const existingProductsMap = new Map(existingProducts.map((p) => [p.name, p]));
        const newProductsDtoMap = new Map(newProductsDto.map((p) => [p.name, p]));

        const productsToDelete = existingProducts.filter((p) => !newProductsDtoMap.has(p.name));
        if (productsToDelete.length > 0) {
            const productIdsToDelete = productsToDelete.map((p) => p.id);
            const usageCount = await tx.productionTaskItem.count({
                where: {
                    productId: { in: productIdsToDelete },
                },
            });
            if (usageCount > 0) {
                throw new BadRequestException(
                    `无法删除产品: ${productsToDelete
                        .map((p) => p.name)
                        .join(', ')}，因为它已被一个或多个生产任务使用。`,
                );
            }

            await tx.productIngredient.deleteMany({ where: { productId: { in: productIdsToDelete } } });
            await tx.product.deleteMany({ where: { id: { in: productIdsToDelete } } });
        }

        for (const productDto of newProductsDto) {
            const existingProduct = existingProductsMap.get(productDto.name);

            if (existingProduct) {
                await tx.product.update({
                    where: { id: existingProduct.id },
                    data: {
                        baseDoughWeight: new Prisma.Decimal(productDto.weight), // [核心修复]
                        procedure: productDto.procedure,
                    },
                });
                await tx.productIngredient.deleteMany({ where: { productId: existingProduct.id } });
                await this._createProductIngredients(tenantId, existingProduct.id, productDto, tx);
            } else {
                const newProduct = await tx.product.create({
                    data: {
                        recipeVersionId: versionId,
                        name: productDto.name,
                        baseDoughWeight: new Prisma.Decimal(productDto.weight), // [核心修复]
                        procedure: productDto.procedure,
                    },
                });
                await this._createProductIngredients(tenantId, newProduct.id, productDto, tx);
            }
        }
    }

    private async _createProductIngredients(
        tenantId: string,
        productId: string,
        productDto: ProductDto,
        tx: Prisma.TransactionClient,
    ) {
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

            const ratioForDb =
                pIngredientDto.ratio === null || pIngredientDto.ratio === undefined
                    ? undefined
                    : new Prisma.Decimal(pIngredientDto.ratio);
            const weightInGramsForDb =
                pIngredientDto.weightInGrams === null || pIngredientDto.weightInGrams === undefined
                    ? undefined
                    : new Prisma.Decimal(pIngredientDto.weightInGrams);

            await tx.productIngredient.create({
                data: {
                    productId: productId,
                    type: pIngredientDto.type,
                    ratio: ratioForDb,
                    weightInGrams: weightInGramsForDb,
                    ingredientId: linkedExtra ? null : pIngredientDto.ingredientId,
                    linkedExtraId: linkedExtra?.id,
                },
            });
        }
    }

    private async createVersionInternal(tenantId: string, familyId: string | null, createRecipeDto: CreateRecipeDto) {
        const { name, type = 'MAIN', category } = createRecipeDto;

        const finalCategory = type === 'MAIN' ? category : 'OTHER';
        if (type === 'MAIN' && !finalCategory) {
            throw new BadRequestException('产品配方必须指定一个品类。');
        }

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
                        data: { name, tenantId, type, category: finalCategory },
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
                return this.createVersionContents(tenantId, recipeVersion.id, createRecipeDto, tx);
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
        );
    }

    private async createVersionContents(
        tenantId: string,
        versionId: string,
        recipeDto: CreateRecipeDto,
        tx: Prisma.TransactionClient,
    ) {
        const {
            name,
            type = 'MAIN',
            ingredients,
            products,
            targetTemp,
            lossRatio,
            procedure,
            category = 'BREAD',
        } = recipeDto;

        const ingredientNames = new Set<string>();
        for (const ing of ingredients) {
            if (ingredientNames.has(ing.name)) {
                throw new BadRequestException(`配方中包含重复的原料或面种: "${ing.name}"`);
            }
            ingredientNames.add(ing.name);
        }
        await this._ensureIngredientsExist(tenantId, recipeDto, tx);

        const preDoughFamilies = await this.preloadPreDoughFamilies(tenantId, ingredients, tx);
        this.calculatePreDoughTotalRatio(ingredients, preDoughFamilies);
        this._validateBakerPercentage(type, category, ingredients);

        await tx.recipeVersion.update({
            where: { id: versionId },
            data: { notes: recipeDto.notes },
        });

        const targetTempForDb =
            targetTemp === null || targetTemp === undefined ? undefined : new Prisma.Decimal(targetTemp);
        const lossRatioForDb =
            lossRatio === null || lossRatio === undefined ? undefined : new Prisma.Decimal(lossRatio);

        const component = await tx.recipeComponent.create({
            data: {
                recipeVersionId: versionId,
                name: name,
                targetTemp: type === 'MAIN' ? targetTempForDb : undefined,
                lossRatio: lossRatioForDb,
                procedure: procedure,
            },
        });

        for (const ingredientDto of ingredients) {
            const linkedPreDough = preDoughFamilies.get(ingredientDto.name);

            const ratioForDb =
                linkedPreDough || ingredientDto.ratio === null || ingredientDto.ratio === undefined
                    ? null
                    : new Prisma.Decimal(ingredientDto.ratio);

            const flourRatioForDb =
                ingredientDto.flourRatio === null || ingredientDto.flourRatio === undefined
                    ? null
                    : new Prisma.Decimal(ingredientDto.flourRatio);

            await tx.componentIngredient.create({
                data: {
                    componentId: component.id,
                    ratio: ratioForDb,
                    flourRatio: flourRatioForDb,
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
                        baseDoughWeight: new Prisma.Decimal(productDto.weight),
                        procedure: productDto.procedure,
                    },
                });
                await this._createProductIngredients(tenantId, product.id, productDto, tx);
            }
        }

        return tx.recipeVersion.findUnique({
            where: { id: versionId },
            include: {
                family: true,
                components: {
                    include: {
                        ingredients: {
                            include: {
                                ingredient: true,
                                linkedPreDough: {
                                    include: {
                                        versions: {
                                            where: { isActive: true },
                                            include: {
                                                components: {
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

    private async _ensureIngredientsExist(tenantId: string, recipeDto: CreateRecipeDto, tx: Prisma.TransactionClient) {
        const { ingredients, products } = recipeDto;
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

                const waterContentForDb = isWater ? 1 : 'waterContent' in ing ? (ing.waterContent ?? 0) : 0;

                existingIngredient = await tx.ingredient.create({
                    data: {
                        tenantId,
                        name: ing.name,
                        type: isWater ? IngredientType.UNTRACKED : IngredientType.STANDARD,
                        isFlour: isWater ? false : 'isFlour' in ing ? (ing.isFlour ?? false) : false,
                        waterContent: new Prisma.Decimal(waterContentForDb),
                    },
                });
            }
            ing.ingredientId = existingIngredient.id;
        }
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
                        components: {
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
                    activeVersion?.components.reduce(
                        (sum, component) => sum + (component._count?.ingredients || 0),
                        0,
                    ) || 0;

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
                versions: {
                    some: {
                        isActive: true,
                        products: {
                            some: {},
                        },
                    },
                },
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

        const groupedByCategory: Record<string, Record<string, { id: string; name: string }[]>> = {};

        familiesWithProductionCount.forEach((family) => {
            const category = family.category;
            const activeVersion = family.versions[0];

            if (activeVersion && activeVersion.products.length > 0) {
                if (!groupedByCategory[category]) {
                    groupedByCategory[category] = {};
                }
                if (!groupedByCategory[category][family.name]) {
                    groupedByCategory[category][family.name] = [];
                }
                activeVersion.products.forEach((product) => {
                    groupedByCategory[category][family.name].push({
                        id: product.id,
                        name: product.name,
                    });
                });
            }
        });

        return groupedByCategory;
    }

    async findOne(familyId: string) {
        const family = await this.prisma.recipeFamily.findFirst({
            where: {
                id: familyId,
            },
            include: {
                versions: {
                    include: {
                        components: {
                            include: {
                                ingredients: {
                                    include: {
                                        ingredient: true,
                                        linkedPreDough: {
                                            include: {
                                                versions: {
                                                    where: { isActive: true },
                                                    include: {
                                                        components: {
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

        // [核心修复] 使用类型安全的方式来处理数据并附加 extraInfo
        const processedFamily = {
            ...family,
            versions: family.versions.map((version) => {
                return {
                    ...version,
                    components: version.components.map((component) => {
                        const ingredientNotes = new Map<string, string>();
                        // [核心修改] 移除正则表达式中不必要的转义字符
                        const noteRegex = /@(?:\[)?(.*?)(?:\])?[(（](.*?)[)）]/g;

                        // [核心修改] 过滤和清理制作步骤
                        const cleanedProcedure = component.procedure
                            .map((step) => {
                                // 首先，提取所有附加说明，存入 map
                                const stepMatches = [...step.matchAll(noteRegex)];
                                for (const match of stepMatches) {
                                    // match[1] 是原料名, match[2] 是括号内的说明
                                    const [, ingredientName, note] = match;
                                    if (ingredientName && note) {
                                        ingredientNotes.set(ingredientName.trim(), note.trim());
                                    }
                                }

                                // 将所有"@原料(说明)"格式的文本块替换为空字符串，并去除前后空格
                                const cleanedStep = step.replace(noteRegex, '').trim();

                                // 如果清理后的步骤为空字符串，则返回 null，后续将被过滤掉
                                if (cleanedStep === '') {
                                    return null;
                                }

                                return cleanedStep;
                            })
                            // 过滤掉所有 null 值的步骤
                            .filter((step): step is string => step !== null);

                        return {
                            ...component,
                            procedure: cleanedProcedure,
                            ingredients: component.ingredients.map((ing) => {
                                if (ing.ingredient) {
                                    const extraInfo = ingredientNotes.get(ing.ingredient.name);
                                    // 创建一个新的 ingredient 对象来附加属性，而不是直接修改
                                    return {
                                        ...ing,
                                        ingredient: {
                                            ...ing.ingredient,
                                            extraInfo: extraInfo || undefined,
                                        },
                                    };
                                }
                                return ing;
                            }),
                        };
                    }),
                };
            }),
        };

        return processedFamily;
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
                components: {
                    include: {
                        ingredients: {
                            include: {
                                ingredient: true,
                                linkedPreDough: {
                                    include: {
                                        versions: {
                                            where: { isActive: true },
                                            include: {
                                                components: {
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

        const toCleanPercent = (decimal: Prisma.Decimal | null | undefined): number | null => {
            if (decimal === null || decimal === undefined) return null;
            return parseFloat(decimal.mul(100).toString());
        };

        if (version.family.type === 'PRE_DOUGH' || version.family.type === 'EXTRA') {
            const componentSource = version.components[0];
            if (!componentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少组件');
            }

            const baseComponent: ComponentTemplate = {
                id: componentSource.id,
                name: componentSource.name,
                type: 'BASE_COMPONENT',
                lossRatio: toCleanPercent(componentSource.lossRatio) ?? undefined,
                ingredients: componentSource.ingredients.map((ing) => ({
                    id: ing.ingredient!.id,
                    name: ing.ingredient!.name,
                    ratio: toCleanPercent(ing.ratio),
                    isRecipe: false,
                    isFlour: ing.ingredient!.isFlour,
                    waterContent: ing.ingredient!.waterContent.toNumber(),
                })),
                procedure: componentSource.procedure || [],
            };
            return {
                name: version.family.name,
                type: version.family.type,
                category: version.family.category,
                notes: version.notes || '',
                components: [baseComponent],
                products: [],
            };
        }

        let componentsForForm: ComponentTemplate[] = [];

        if (version.family.category === RecipeCategory.BREAD) {
            const mainComponentSource = version.components.find((c) => c.name === version.family.name);
            if (!mainComponentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少主组件');
            }

            const mainComponentIngredientsForForm: ComponentTemplate['ingredients'] = [];
            const preDoughComponentsForForm: ComponentTemplate[] = [];

            for (const ing of mainComponentSource.ingredients) {
                if (ing.linkedPreDough) {
                    const preDoughFamily = ing.linkedPreDough;
                    const preDoughActiveVersion = preDoughFamily.versions.find((v) => v.isActive);
                    const preDoughRecipe = preDoughActiveVersion?.components?.[0];

                    if (preDoughRecipe) {
                        const flourRatioInMainDough = ing.flourRatio
                            ? new Prisma.Decimal(ing.flourRatio)
                            : new Prisma.Decimal(0);
                        const ingredientsForTemplate = preDoughRecipe.ingredients
                            .filter((i) => i.ingredient !== null && i.ratio !== null)
                            .map((i) => ({
                                id: i.ingredient!.id,
                                name: i.ingredient!.name,
                                ratio: toCleanPercent(flourRatioInMainDough.mul(i.ratio!)),
                                isRecipe: false,
                                isFlour: i.ingredient!.isFlour,
                                waterContent: i.ingredient!.waterContent.toNumber(),
                            }));

                        preDoughComponentsForForm.push({
                            id: preDoughFamily.id,
                            name: preDoughFamily.name,
                            type: 'PRE_DOUGH',
                            flourRatioInMainDough: toCleanPercent(flourRatioInMainDough) ?? undefined,
                            ingredients: ingredientsForTemplate,
                            procedure: preDoughRecipe.procedure,
                        });
                    }
                } else if (ing.ingredient && ing.ratio) {
                    mainComponentIngredientsForForm.push({
                        id: ing.ingredient.id,
                        name: ing.ingredient.name,
                        ratio: toCleanPercent(ing.ratio),
                        isRecipe: false,
                        isFlour: ing.ingredient.isFlour,
                        waterContent: ing.ingredient.waterContent.toNumber(),
                    });
                }
            }

            const mainComponentForForm: ComponentTemplate = {
                id: `main_${Date.now()}`,
                name: '主面团',
                type: 'MAIN_DOUGH',
                lossRatio: toCleanPercent(mainComponentSource.lossRatio) ?? undefined,
                ingredients: mainComponentIngredientsForForm,
                procedure: mainComponentSource.procedure || [],
            };
            componentsForForm = [mainComponentForForm, ...preDoughComponentsForForm];
        } else {
            const componentSource = version.components[0];
            if (!componentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少组件');
            }
            const baseComponent: ComponentTemplate = {
                id: componentSource.id,
                name: componentSource.name,
                type: 'BASE_COMPONENT',
                lossRatio: toCleanPercent(componentSource.lossRatio) ?? undefined,
                ingredients: componentSource.ingredients.map((ing) => ({
                    id: ing.ingredient!.id,
                    name: ing.ingredient!.name,
                    ratio: toCleanPercent(ing.ratio),
                    isRecipe: false,
                    isFlour: ing.ingredient!.isFlour,
                    waterContent: ing.ingredient!.waterContent.toNumber(),
                })),
                procedure: componentSource.procedure || [],
            };
            componentsForForm = [baseComponent];
        }

        const formTemplate: RecipeFormTemplateDto = {
            name: version.family.name,
            type: version.family.type,
            category: version.family.category,
            notes: version.notes || '',
            targetTemp: version.components[0]?.targetTemp?.toNumber() ?? undefined,
            components: componentsForForm,
            products: version.products.map((p) => {
                const processIngredients = (type: ProductIngredientType) => {
                    return p.ingredients
                        .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                        .map((ing) => {
                            const name = ing.ingredient?.name || ing.linkedExtra?.name || '';
                            return {
                                id: ing.ingredient?.id || ing.linkedExtra?.id || null,
                                name,
                                ratio: toCleanPercent(ing.ratio),
                                weightInGrams: ing.weightInGrams?.toNumber(),
                                isRecipe: !!ing.linkedExtra,
                                isFlour: ing.ingredient?.isFlour ?? false,
                                waterContent: ing.ingredient?.waterContent.toNumber() ?? 0,
                            };
                        });
                };
                return {
                    name: p.name,
                    baseDoughWeight: p.baseDoughWeight.toNumber(),
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
        ingredients: ComponentIngredientDto[],
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
                    include: { components: { include: { ingredients: true } } },
                },
            },
        });

        return new Map(families.map((f) => [f.name, f as PreloadedRecipeFamily]));
    }

    private calculatePreDoughTotalRatio(
        ingredients: ComponentIngredientDto[],
        preDoughFamilies: Map<string, PreloadedRecipeFamily>,
    ) {
        for (const ing of ingredients) {
            if (ing.flourRatio !== undefined && ing.flourRatio !== null) {
                const preDoughFamily = preDoughFamilies.get(ing.name);
                const preDoughRecipe = preDoughFamily?.versions[0]?.components[0];

                if (!preDoughRecipe) {
                    throw new BadRequestException(`名为 "${ing.name}" 的预制面团配方不存在或未激活。`);
                }

                const preDoughTotalRatioSum = preDoughRecipe.ingredients.reduce(
                    (sum, i) => sum + (i.ratio ? new Prisma.Decimal(i.ratio).toNumber() : 0),
                    0,
                );

                if (preDoughTotalRatioSum > 0) {
                    ing.ratio = new Prisma.Decimal(ing.flourRatio).mul(preDoughTotalRatioSum).toNumber();
                } else {
                    ing.ratio = 0;
                }
            }
        }
    }

    private _validateBakerPercentage(
        type: RecipeType,
        category: RecipeCategory | undefined,
        ingredients: ComponentIngredientDto[],
    ) {
        if (category !== RecipeCategory.BREAD && type !== RecipeType.PRE_DOUGH) {
            return;
        }

        let totalFlourRatio = new Prisma.Decimal(0);

        for (const ingredientDto of ingredients) {
            if (ingredientDto.flourRatio !== undefined && ingredientDto.flourRatio !== null) {
                totalFlourRatio = totalFlourRatio.add(new Prisma.Decimal(ingredientDto.flourRatio));
            } else if (ingredientDto.isFlour) {
                totalFlourRatio = totalFlourRatio.add(new Prisma.Decimal(ingredientDto.ratio ?? 0));
            }
        }

        if (totalFlourRatio.sub(1).abs().gt(0.001)) {
            throw new BadRequestException(
                `配方验证失败：所有面粉类原料（包括用于制作预制面团的面粉）的比例总和必须为100%。当前计算总和为: ${totalFlourRatio
                    .mul(100)
                    .toFixed(2)}%`,
            );
        }
    }
}
