import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto, DoughIngredientDto, ProductDto } from './dto/create-recipe.dto'; // [核心修正] 补全对 ProductDto 的导入
// [核心修复] 在导入语句中加入 RecipeComponent 和 ComponentIngredient 类型
import {
    Prisma,
    RecipeFamily,
    RecipeVersion,
    ProductIngredientType,
    IngredientType,
    RecipeComponent,
    ComponentIngredient,
    Product, // [核心修改] 导入 Product
    RecipeCategory, // [核心新增] 导入 RecipeCategory
} from '@prisma/client';
import { RecipeFormTemplateDto } from './dto/recipe-form-template.dto';
import type { DoughTemplate } from './dto/recipe-form-template.dto';

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

// [核心新增] 为预加载的配方家族定义更精确的类型
type PreloadedRecipeFamily = RecipeFamily & {
    versions: (RecipeVersion & {
        components: (RecipeComponent & {
            // [核心重命名] doughs -> components
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

    // [核心改造] 重构 updateVersion 函数，采用“同步”逻辑代替“先删后创”，以保留产品ID，防止历史任务数据显示为“未知产品”
    async updateVersion(tenantId: string, familyId: string, versionId: string, updateRecipeDto: CreateRecipeDto) {
        // 1. 验证版本是否存在
        const versionToUpdate = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: { tenantId },
            },
            include: {
                products: true, // [核心改造] 预加载现有产品用于后续对比
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

        // 3. [核心改造] 执行新的同步逻辑
        return this.prisma.$transaction(async (tx) => {
            const {
                ingredients,
                products,
                targetTemp,
                lossRatio,
                procedure,
                name,
                type = 'MAIN',
                category = 'BREAD',
            } = updateRecipeDto;

            // 3.1 [核心改造] 处理配方组件部分：对于组件，仍然可以采用先删后创
            await tx.componentIngredient.deleteMany({
                where: { component: { recipeVersionId: versionId } },
            });
            await tx.recipeComponent.deleteMany({
                where: { recipeVersionId: versionId },
            });

            // 重新验证并创建组件及原料
            const ingredientNames = new Set<string>();
            for (const ing of ingredients) {
                if (ingredientNames.has(ing.name)) {
                    throw new BadRequestException(`配方中包含重复的原料或面种: "${ing.name}"`);
                }
                ingredientNames.add(ing.name);
            }
            // [核心改造] 将原料检查和自动创建逻辑提前，确保在处理产品之前所有原料都已存在
            await this._ensureIngredientsExist(tenantId, updateRecipeDto, tx);

            const preDoughFamilies = await this.preloadPreDoughFamilies(tenantId, ingredients, tx);
            this.calculatePreDoughTotalRatio(ingredients, preDoughFamilies);
            // [核心改造] 根据品类决定是否执行烘焙百分比验证
            this._validateBakerPercentage(category, ingredients);

            const component = await tx.recipeComponent.create({
                // [核心重命名] dough -> component
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
                await tx.componentIngredient.create({
                    // [核心重命名] doughIngredient -> componentIngredient
                    data: {
                        componentId: component.id, // [核心重命名] doughId -> componentId
                        ratio: linkedPreDough ? null : ingredientDto.ratio,
                        flourRatio: ingredientDto.flourRatio,
                        ingredientId: linkedPreDough ? null : ingredientDto.ingredientId,
                        linkedPreDoughId: linkedPreDough?.id,
                    },
                });
            }

            // 3.2 [核心改造] 处理产品部分：执行同步逻辑
            await this._syncProductsForVersion(tenantId, versionId, versionToUpdate.products, products || [], tx);

            // 3.3 更新版本备注
            await tx.recipeVersion.update({
                where: { id: versionId },
                data: { notes: updateRecipeDto.notes },
            });

            // 3.4 返回更新后的完整数据
            return this.prisma.recipeVersion.findUnique({
                where: { id: versionId },
                include: {
                    family: true,
                    components: {
                        // [核心重命名] doughs -> components
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

    // [核心新增] 这是一个新的私有方法，用于同步产品列表
    private async _syncProductsForVersion(
        tenantId: string,
        versionId: string,
        existingProducts: Product[],
        newProductsDto: ProductDto[],
        tx: Prisma.TransactionClient,
    ) {
        const existingProductsMap = new Map(existingProducts.map((p) => [p.name, p]));
        const newProductsDtoMap = new Map(newProductsDto.map((p) => [p.name, p]));

        // 1. 识别要删除的产品
        const productsToDelete = existingProducts.filter((p) => !newProductsDtoMap.has(p.name));
        if (productsToDelete.length > 0) {
            // [核心新增] 在删除单个产品前，再次进行精确检查，确保这个产品没有被任何任务使用
            const productIdsToDelete = productsToDelete.map((p) => p.id);
            const usageCount = await tx.productionTaskItem.count({
                where: {
                    productId: { in: productIdsToDelete },
                },
            });
            if (usageCount > 0) {
                // 如果发现即将被删除的产品已经被任务使用，则抛出异常，防止数据不一致
                throw new BadRequestException(
                    `无法删除产品: ${productsToDelete
                        .map((p) => p.name)
                        .join(', ')}，因为它已被一个或多个生产任务使用。`,
                );
            }

            // 先删除关联的原料，再删除产品本身
            await tx.productIngredient.deleteMany({ where: { productId: { in: productIdsToDelete } } });
            await tx.product.deleteMany({ where: { id: { in: productIdsToDelete } } });
        }

        // 2. 遍历新的产品 DTO，进行更新或创建
        for (const productDto of newProductsDto) {
            const existingProduct = existingProductsMap.get(productDto.name);

            if (existingProduct) {
                // 2.1 产品已存在 -> 更新
                await tx.product.update({
                    where: { id: existingProduct.id },
                    data: {
                        baseDoughWeight: productDto.weight,
                        procedure: productDto.procedure,
                    },
                });
                // 清理旧的原料，然后重新创建
                await tx.productIngredient.deleteMany({ where: { productId: existingProduct.id } });
                await this._createProductIngredients(tenantId, existingProduct.id, productDto, tx);
            } else {
                // 2.2 产品不存在 -> 创建
                const newProduct = await tx.product.create({
                    data: {
                        recipeVersionId: versionId,
                        name: productDto.name,
                        baseDoughWeight: productDto.weight,
                        procedure: productDto.procedure,
                    },
                });
                await this._createProductIngredients(tenantId, newProduct.id, productDto, tx);
            }
        }
    }

    // [核心新增] 这是一个新的辅助函数，用于统一处理产品原料的创建逻辑，避免代码重复
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
            await tx.productIngredient.create({
                data: {
                    productId: productId,
                    type: pIngredientDto.type,
                    ratio: pIngredientDto.ratio,
                    weightInGrams: pIngredientDto.weightInGrams,
                    ingredientId: linkedExtra ? null : pIngredientDto.ingredientId,
                    linkedExtraId: linkedExtra?.id,
                },
            });
        }
    }

    private async createVersionInternal(tenantId: string, familyId: string | null, createRecipeDto: CreateRecipeDto) {
        const { name, type = 'MAIN', category = 'BREAD' } = createRecipeDto; // [核心改造] 读取 category

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
                        data: { name, tenantId, type, category }, // [核心改造] 保存 category
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
                // [核心改造] 将原 recreateVersionContents 的逻辑拆分并在此处调用
                return this.createVersionContents(tenantId, recipeVersion.id, createRecipeDto, tx);
            },
            {
                isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            },
        );
    }

    // [核心改造] 将原 recreateVersionContents 重命名为 createVersionContents，并移除产品删除逻辑
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
        // [核心改造] 调用独立的原料确保函数
        await this._ensureIngredientsExist(tenantId, recipeDto, tx);

        const preDoughFamilies = await this.preloadPreDoughFamilies(tenantId, ingredients, tx);
        this.calculatePreDoughTotalRatio(ingredients, preDoughFamilies);
        // [核心改造] 根据品类决定是否执行烘焙百分比验证
        this._validateBakerPercentage(category, ingredients);

        await tx.recipeVersion.update({
            where: { id: versionId },
            data: { notes: recipeDto.notes },
        });

        const component = await tx.recipeComponent.create({
            // [核心重命名] dough -> component
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
            await tx.componentIngredient.create({
                // [核心重命名] doughIngredient -> componentIngredient
                data: {
                    componentId: component.id, // [核心重命名] doughId -> componentId
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
                // [核心改造] 调用抽离的原料创建函数
                await this._createProductIngredients(tenantId, product.id, productDto, tx);
            }
        }

        return tx.recipeVersion.findUnique({
            where: { id: versionId },
            include: {
                family: true,
                components: {
                    // [核心重命名] doughs -> components
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
                                                    // [核心重命名] doughs -> components
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

    // [核心新增] 新增一个私有方法，用于检查并自动创建配方中尚不存在的原料
    private async _ensureIngredientsExist(tenantId: string, recipeDto: CreateRecipeDto, tx: Prisma.TransactionClient) {
        const { ingredients, products } = recipeDto;
        const allRawIngredients = [
            ...ingredients,
            ...(products ?? []).flatMap((p) => [...(p.mixIn ?? []), ...(p.fillings ?? []), ...(p.toppings ?? [])]),
        ];

        for (const ing of allRawIngredients) {
            if (ing.ingredientId) continue; // 如果已经有ID，跳过

            // 检查是否为预制件或附加项
            const isPreDoughOrExtra = await tx.recipeFamily.findFirst({
                where: { name: ing.name, tenantId, type: { in: ['PRE_DOUGH', 'EXTRA'] } },
            });
            if (isPreDoughOrExtra) continue;

            // 检查原料是否已存在
            let existingIngredient = await tx.ingredient.findFirst({
                where: { tenantId, name: ing.name, deletedAt: null },
            });

            // 如果不存在，则创建新原料
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
            // 将找到的或创建的ID回写到DTO对象中，供后续使用
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
                            // [核心重命名] doughs -> components
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
                        components: {
                            // [核心重命名] doughs -> components
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
                                                            // [核心重命名] doughs -> components
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
                components: {
                    // [核心重命名] doughs -> components
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
                                                    // [核心重命名] doughs -> components
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
            const componentSource = version.components[0];
            if (!componentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少组件');
            }

            return {
                name: version.family.name,
                type: version.family.type,
                category: version.family.category, // [核心修复] 增加 category 字段
                notes: version.notes || '',
                ingredients: componentSource.ingredients
                    .filter((ing) => ing.ingredient && ing.ratio !== null)
                    .map((ing) => ({
                        id: ing.ingredient!.id,
                        name: ing.ingredient!.name,
                        ratio: new Prisma.Decimal(ing.ratio!).mul(100).toNumber(),
                        isRecipe: false,
                        isFlour: ing.ingredient!.isFlour,
                        waterContent: ing.ingredient!.waterContent.toNumber(),
                    })),
                procedure: componentSource.procedure || [],
            };
        }

        const mainComponentSource = version.components.find((d) => d.name === version.family.name);
        if (!mainComponentSource) {
            throw new NotFoundException('源配方数据不完整: 缺少主组件');
        }

        const mainComponentIngredientsForForm: {
            id: string | null;
            name: string;
            ratio: number | null;
            isRecipe: boolean;
            isFlour?: boolean;
            waterContent?: number;
        }[] = [];
        const preDoughObjectsForForm: DoughTemplate[] = [];

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
                            ratio: flourRatioInMainDough.mul(i.ratio!).mul(100).toNumber(),
                            isRecipe: false,
                            isFlour: i.ingredient!.isFlour,
                            waterContent: i.ingredient!.waterContent.toNumber(),
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
                mainComponentIngredientsForForm.push({
                    id: ing.ingredient.id,
                    name: ing.ingredient.name,
                    ratio: new Prisma.Decimal(ing.ratio).mul(100).toNumber(),
                    isRecipe: false,
                    isFlour: ing.ingredient.isFlour,
                    waterContent: ing.ingredient.waterContent.toNumber(),
                });
            }
        }

        const mainDoughObjectForForm: DoughTemplate = {
            id: `main_${Date.now()}`,
            name: '主面团',
            type: 'MAIN_DOUGH' as const,
            lossRatio: mainComponentSource.lossRatio
                ? new Prisma.Decimal(mainComponentSource.lossRatio).mul(100).toNumber()
                : 0,
            ingredients: mainComponentIngredientsForForm,
            procedure: mainComponentSource.procedure || [],
        };

        const formTemplate: RecipeFormTemplateDto = {
            name: version.family.name,
            type: 'MAIN',
            category: version.family.category, // [核心修复] 增加 category 字段
            notes: version.notes || '',
            targetTemp: mainComponentSource.targetTemp?.toNumber() ?? undefined,
            doughs: [mainDoughObjectForForm, ...preDoughObjectsForForm],
            products: version.products.map((p) => {
                const processIngredients = (type: ProductIngredientType) => {
                    return p.ingredients
                        .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                        .map((ing) => ({
                            id: ing.ingredient?.id || ing.linkedExtra?.id || null,
                            name: ing.ingredient?.name || ing.linkedExtra?.name || '',
                            ratio: ing.ratio ? new Prisma.Decimal(ing.ratio).mul(100).toNumber() : null,
                            weightInGrams: ing.weightInGrams?.toNumber(),
                            isRecipe: !!ing.linkedExtra,
                            isFlour: ing.ingredient?.isFlour ?? false,
                            waterContent: ing.ingredient?.waterContent.toNumber() ?? 0,
                        }));
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
                    include: { components: { include: { ingredients: true } } }, // [核心重命名] doughs -> components
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
                const preDoughRecipe = preDoughFamily?.versions[0]?.components[0]; // [核心重命名] doughs -> components

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

    // [核心改造] 增加 category 参数，并根据其值决定是否执行验证
    private _validateBakerPercentage(category: RecipeCategory, ingredients: DoughIngredientDto[]) {
        // [核心改造] 如果品类不是面包，则直接跳过验证
        if (category !== RecipeCategory.BREAD) {
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

        // 使用 Decimal.js 的 `sub` 和 `abs` 方法进行高精度比较
        if (totalFlourRatio.sub(1).abs().gt(0.001)) {
            throw new BadRequestException(
                `配方验证失败：所有面粉类原料（包括用于制作预制面团的面粉）的比例总和必须为100%。当前计算总和为: ${totalFlourRatio
                    .mul(100)
                    .toFixed(2)}%`,
            );
        }
    }
}
