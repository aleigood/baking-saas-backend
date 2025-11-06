import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecipeDto, ComponentIngredientDto, ProductDto, ProductIngredientDto } from './dto/create-recipe.dto';
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
    Ingredient,
    Role,
} from '@prisma/client';
import { RecipeFormTemplateDto, ComponentTemplate } from './dto/recipe-form-template.dto';
import {
    BatchImportRecipeDto,
    BatchImportResultDto,
    BatchImportVersionDto,
    BatchComponentIngredientDto, // [核心新增]
    BatchProductDto, // [核心新增]
} from './dto/batch-import-recipe.dto';

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

type PreloadedRecipeFamily = RecipeFamily & {
    versions: (RecipeVersion & {
        components: (RecipeComponent & {
            ingredients: ComponentIngredient[];
        })[];
    })[];
};

// [核心修改] 在 products 的 include 中增加了 where: { deletedAt: null }，确保不返回已软删除的产品
const recipeFamilyWithDetailsInclude = {
    versions: {
        include: {
            components: {
                include: {
                    ingredients: {
                        include: {
                            ingredient: true,
                            linkedPreDough: true,
                        },
                    },
                },
            },
            products: {
                where: { deletedAt: null }, // [核心修改] 过滤掉软删除的产品
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
} satisfies Prisma.RecipeFamilyInclude;

type RecipeFamilyWithDetails = Prisma.RecipeFamilyGetPayload<{
    include: typeof recipeFamilyWithDetailsInclude;
}>;

@Injectable()
export class RecipesService {
    constructor(private prisma: PrismaService) {}

    // [核心新增] 排序辅助函数
    // [核心修改]
    // 1. 修复 Prettier 括号错误 (移除 ingredients: (...)[] )
    // 2. 改为泛型以保留传入的深层类型，修复 typescript-eslint/no-unsafe-* 错误
    private _sortIngredients<
        T extends Prisma.ComponentIngredientGetPayload<{
            include: {
                ingredient: true;
                linkedPreDough: true; // 最小类型约束
            };
        }>,
    >(ingredients: T[], category: RecipeCategory, type: RecipeType): T[] {
        // 规则1：面包类 和 面种类 应用面粉优先排序
        const isFlourSort = type === 'PRE_DOUGH' || category === 'BREAD';

        return ingredients.sort((a, b) => {
            // 1. 优先排序面种 (linkedPreDough)
            const aIsPreDough = !!a.linkedPreDoughId;
            const bIsPreDough = !!b.linkedPreDoughId;
            if (aIsPreDough && !bIsPreDough) return -1;
            if (!aIsPreDough && bIsPreDough) return 1;

            // 2. 如果是面包或面种类，应用面粉优先规则
            if (isFlourSort) {
                const aIsFlour = a.ingredient?.isFlour ?? false;
                const bIsFlour = b.ingredient?.isFlour ?? false;

                if (aIsFlour && !bIsFlour) return -1;
                if (!aIsFlour && bIsFlour) return 1;
            }

            // 3. 按用量倒序 (flourRatio 优先于 ratio)
            const aRatio = a.flourRatio ?? a.ratio ?? new Prisma.Decimal(0);
            const bRatio = b.flourRatio ?? b.ratio ?? new Prisma.Decimal(0);
            return new Prisma.Decimal(bRatio).cmp(new Prisma.Decimal(aRatio));
        });
    }

    // [核心重命名] 修改 _sanitizeFamily 方法内部变量名
    private _sanitizeFamily(family: RecipeFamilyWithDetails | null) {
        if (!family) {
            return null;
        }
        return {
            ...family,
            versions: family.versions.map((version) => ({
                ...version,
                components: version.components.map((component) => {
                    // [核心修改] 调用排序辅助函数
                    // [核心修改] 修复 Prettier 换行
                    const sortedIngredients = this._sortIngredients(
                        component.ingredients,
                        family.category,
                        family.type,
                    );

                    return {
                        ...component,
                        targetTemp: component.targetTemp?.toNumber(),
                        lossRatio: component.lossRatio?.toNumber(),
                        divisionLoss: component.divisionLoss?.toNumber(),
                        // [核心重命名] ing -> componentIngredient
                        // [核心修改] 使用 sortedIngredients
                        ingredients: sortedIngredients.map((componentIngredient) => ({
                            ...componentIngredient,
                            ratio: componentIngredient.ratio?.toNumber(),
                            flourRatio: componentIngredient.flourRatio?.toNumber(),
                            ingredient: componentIngredient.ingredient
                                ? {
                                      ...componentIngredient.ingredient,
                                      waterContent: componentIngredient.ingredient.waterContent.toNumber(),
                                      currentStockInGrams:
                                          componentIngredient.ingredient.currentStockInGrams.toNumber(),
                                      currentStockValue: componentIngredient.ingredient.currentStockValue.toNumber(),
                                  }
                                : null,
                        })),
                    };
                }),
                products: version.products.map((product) => ({
                    ...product,
                    baseDoughWeight: product.baseDoughWeight.toNumber(),
                    // [核心重命名] pIng -> productIngredient
                    ingredients: product.ingredients.map((productIngredient) => ({
                        ...productIngredient,
                        ratio: productIngredient.ratio?.toNumber(),
                        weightInGrams: productIngredient.weightInGrams?.toNumber(),
                        ingredient: productIngredient.ingredient
                            ? {
                                  ...productIngredient.ingredient,
                                  waterContent: productIngredient.ingredient.waterContent.toNumber(),
                                  currentStockInGrams: productIngredient.ingredient.currentStockInGrams.toNumber(),
                                  currentStockValue: productIngredient.ingredient.currentStockValue.toNumber(),
                              }
                            : null,
                    })),
                })),
            })),
        };
    }

    // [核心修改] 重写 batchImportRecipes 方法以支持多版本导入
    async batchImportRecipes(
        userId: string,
        recipesDto: BatchImportRecipeDto[], // [核心修改] 使用新的 Family DTO
        tenantIds?: string[],
    ): Promise<BatchImportResultDto> {
        let targetTenants: { id: string; name: string }[];

        // 1. 获取目标店铺 (与旧逻辑相同)
        if (tenantIds && tenantIds.length > 0) {
            const ownedTenants = await this.prisma.tenant.findMany({
                where: {
                    id: { in: tenantIds },
                    members: {
                        some: {
                            userId,
                            role: Role.OWNER,
                        },
                    },
                },
                select: { id: true, name: true },
            });

            if (ownedTenants.length !== tenantIds.length) {
                throw new BadRequestException('包含了您没有权限的店铺ID。');
            }
            targetTenants = ownedTenants;
        } else {
            const allOwnedTenants = await this.prisma.tenant.findMany({
                where: {
                    members: {
                        some: {
                            userId,
                            role: Role.OWNER,
                        },
                    },
                },
                select: { id: true, name: true },
            });
            targetTenants = allOwnedTenants;
        }

        if (targetTenants.length === 0) {
            throw new BadRequestException('没有找到可导入的店铺。');
        }

        const overallResult: BatchImportResultDto = {
            totalCount: recipesDto.length * targetTenants.length, // [核心修改] totalCount 语义变为 "总配方族数"
            importedCount: 0,
            skippedCount: 0,
            skippedRecipes: [],
        };

        // 2. 遍历所有目标店铺
        for (const tenant of targetTenants) {
            const tenantId = tenant.id;
            const tenantName = tenant.name;

            // [核心修改] 移除旧的 Set<existingFamilyNames> 逻辑

            // 3. 遍历所有配方族 DTO
            for (const recipeDto of recipesDto) {
                try {
                    // 4. 检查配方族 (RecipeFamily) 是否已存在
                    const existingFamily = await this.prisma.recipeFamily.findFirst({
                        where: {
                            tenantId,
                            name: recipeDto.name,
                            deletedAt: null,
                        },
                        include: {
                            versions: { select: { notes: true } }, // 仅查询 notes 用于去重
                        },
                    });

                    // 5. 准备将 JSON DTO 转换为内部 CreateRecipeDto 的辅助函数
                    // [核心重用] 这段转换逻辑来自你原来的 batchImportRecipes 方法
                    // [核心修改] 明确 BatchImportVersionDto 类型，修复 Prettier 错误
                    const convertVersionToCreateDto = (versionDto: BatchImportVersionDto): CreateRecipeDto => {
                        // [核心修改] 修复 ESLint no-unsafe-* 错误 [cite: 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
                        // 通过使用强类型的 versionDto
                        return {
                            name: recipeDto.name,
                            type: recipeDto.type,
                            category: recipeDto.category,
                            // 从 versionDto 展开版本特定字段
                            notes: versionDto.notes, // [cite: 4]
                            targetTemp: versionDto.targetTemp, // [cite: 6]
                            lossRatio: versionDto.lossRatio, // [cite: 8]
                            divisionLoss: versionDto.divisionLoss, // [cite: 10]
                            procedure: versionDto.procedure, // [cite: 12]
                            // 转换 ComponentIngredientDto (结构已匹配，直接用)
                            // [cite: 14, 15]
                            ingredients: versionDto.ingredients.map(
                                // [核心修改] 明确类型 (ing: BatchComponentIngredientDto)
                                (ing: BatchComponentIngredientDto): ComponentIngredientDto => ({
                                    ...ing, // [cite: 16]
                                    ingredientId: undefined, // 确保 ID 未定义，由 service 内部处理
                                }),
                            ),
                            // 转换 ProductDto (结构不匹配，需要翻译)
                            // [cite: 18, 19]
                            products: versionDto.products?.map(
                                // [核心修改] 明确类型 (p: BatchProductDto)
                                (p: BatchProductDto): ProductDto => ({
                                    ...p, // 包含 name, weight, procedure
                                    id: undefined, // 确保 ID 未定义
                                    // [核心重用] 下面的 mixIn, fillings, toppings 转换逻辑来自你的旧代码
                                    // [核心修改] 修复 ESLint no-unsafe-* 错误 [cite: 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]
                                    mixIn:
                                        p.mixIn?.map(
                                            // [cite: 22]
                                            (i): ProductIngredientDto => ({
                                                ...i, // [cite: 24]
                                                type: ProductIngredientType.MIX_IN,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                    fillings:
                                        p.fillings?.map(
                                            // [cite: 26]
                                            (i): ProductIngredientDto => ({
                                                ...i, // [cite: 28]
                                                type: ProductIngredientType.FILLING,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                    toppings:
                                        p.toppings?.map(
                                            // [cite: 30]
                                            (i): ProductIngredientDto => ({
                                                ...i, // [cite: 32]
                                                type: ProductIngredientType.TOPPING,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                }),
                            ),
                        };
                    };

                    if (!existingFamily) {
                        // 6. [情况 A] 配方族不存在：创建配方族和所有版本
                        let familyId: string | null = null;
                        let versionsCreatedCount = 0;

                        // [核心修改] 修复 'Property 'versions' does not exist' [cite: 32]
                        for (const versionDto of recipeDto.versions) {
                            const createDto = convertVersionToCreateDto(versionDto);

                            if (familyId === null) {
                                // 第一个版本：调用 this.create() 创建 Family 和 V1
                                const createdFamily = await this.create(tenantId, createDto);

                                // [核心修改] 修复 'createdFamily' is possibly 'null' 错误
                                if (!createdFamily) {
                                    throw new Error(`创建配方族 "${recipeDto.name}" 失败，_sanitizeFamily 返回 null`);
                                }
                                familyId = createdFamily.id;
                                versionsCreatedCount++;
                            } else {
                                // 后续版本：调用 this.createVersion() 添加 V2, V3...
                                await this.createVersion(tenantId, familyId, createDto);
                                versionsCreatedCount++;
                            }
                        }
                        if (versionsCreatedCount > 0) {
                            overallResult.importedCount++;
                        } else {
                            // 理论上不应该发生，除非 versions 数组为空
                            overallResult.skippedCount++;
                            overallResult.skippedRecipes.push(
                                `${recipeDto.name} (在店铺 "${tenantName}" 导入失败, DTO 中没有版本信息)`,
                            );
                        }
                    } else {
                        // 7. [情况 B] 配方族已存在：只添加新版本 (通过 notes 字段判断)
                        const existingVersionNotes = new Set(existingFamily.versions.map((v) => v.notes));
                        let newVersionsAdded = 0;

                        // [核心修改] 修复 'Property 'versions' does not exist' [cite: 34]
                        for (const versionDto of recipeDto.versions) {
                            // [核心修改] 修复 'Unsafe member access .notes' [cite: 35]
                            if (existingVersionNotes.has(versionDto.notes)) {
                                // 备注(notes) 相同，视为同一版本，跳过
                                continue;
                            }

                            // 发现新版本，调用 createVersion() 添加
                            const createDto = convertVersionToCreateDto(versionDto);
                            await this.createVersion(tenantId, existingFamily.id, createDto);
                            newVersionsAdded++;
                        }

                        if (newVersionsAdded > 0) {
                            overallResult.importedCount++; // 成功为现有配方族添加了新版本
                        } else {
                            overallResult.skippedCount++;
                            overallResult.skippedRecipes.push(
                                `${recipeDto.name} (在店铺 "${tenantName}" 已存在且无新版本)`,
                            );
                        }
                    }
                } catch (error) {
                    // 8. 错误处理 (与旧逻辑相同)
                    const typedError = error as Error;
                    console.error(`向店铺 ${tenantName} 导入配方 "${recipeDto.name}" 失败:`, typedError);
                    overallResult.skippedCount++;
                    overallResult.skippedRecipes.push(
                        `${recipeDto.name} (在店铺 "${tenantName}" 导入失败: ${typedError.message})`,
                    );
                }
            }
        }

        return overallResult;
    }

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
                products: {
                    where: { deletedAt: null }, // [核心修改] 只包括未软删除的产品
                },
            },
        });

        if (!versionToUpdate) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        // [核心修改] 移除对 IN_PROGRESS 任务的检查
        // const productIds = versionToUpdate.products.map((p) => p.id);
        // if (productIds.length > 0) {
        //     const inProgressUsageCount = await this.prisma.productionTaskItem.count({
        //         where: {
        //             productId: { in: productIds },
        //             task: {
        //                 status: 'IN_PROGRESS', // [核心修改] 只检查 "进行中"
        //             },
        //         },
        //     });
        //     if (inProgressUsageCount > 0) {
        //         // 如果正在生产中，则抛出错误
        //         throw new BadRequestException('此配方版本正在生产中，无法修改。请等待任务完成后再试。');
        //     }
        // }

        return this.prisma.$transaction(async (tx) => {
            const {
                ingredients,
                products,
                targetTemp,
                lossRatio,
                divisionLoss,
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
                    divisionLoss: divisionLoss,
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

            // [核心修改] 调用重写后的产品同步方法
            await this._syncProductsForVersion(tenantId, versionId, versionToUpdate.products, products || [], tx);

            await tx.recipeVersion.update({
                where: { id: versionId },
                data: { notes: updateRecipeDto.notes },
            });

            const updatedFamily = await this.prisma.recipeFamily.findUnique({
                where: { id: familyId },
                include: recipeFamilyWithDetailsInclude,
            });

            return this._sanitizeFamily(updatedFamily);
        });
    }

    // [核心重构] 重写 _syncProductsForVersion 方法，实现 "按ID匹配" 和 "软删除"
    private async _syncProductsForVersion(
        tenantId: string,
        versionId: string,
        existingProducts: Product[],
        newProductsDto: ProductDto[],
        tx: Prisma.TransactionClient,
    ) {
        const existingProductsMap = new Map(existingProducts.map((p) => [p.id, p]));
        // 假设 ProductDto 中有 id?: string
        const newProductIds = new Set(newProductsDto.filter((p) => p.id).map((p) => p.id!));

        // 1. 找出需要软删除的产品
        const productsToSoftDelete = existingProducts.filter((p) => !newProductIds.has(p.id));

        if (productsToSoftDelete.length > 0) {
            const productIdsToSoftDelete = productsToSoftDelete.map((p) => p.id);

            // 2. 检查这些产品是否在 "待开始" 或 "进行中" 的任务里
            const usageCount = await tx.productionTaskItem.count({
                where: {
                    productId: { in: productIdsToSoftDelete },
                    // [核心修改] 只检查 "待开始" 和 "进行中" 的任务
                    task: {
                        status: { in: ['PENDING', 'IN_PROGRESS'] },
                    },
                },
            });

            if (usageCount > 0) {
                // 如果在活动任务中，则阻止删除
                const productNames = productsToSoftDelete.map((p) => p.name).join(', ');
                throw new BadRequestException(
                    `无法删除产品: ${productNames}，因为它已被一个“待开始”或“进行中”的生产任务使用。`,
                );
            }

            // 3. 执行软删除 (对已完成或已取消任务中使用的产品是安全的)
            await tx.product.updateMany({
                where: { id: { in: productIdsToSoftDelete } },
                data: { deletedAt: new Date() },
            });
            // 注意：我们不再硬删除 productIngredient，因为产品只是被隐藏
            // 但如果需要，可以清除它们：
            // await tx.productIngredient.deleteMany({ where: { productId: { in: productIdsToSoftDelete } } });
        }

        // 4. 遍历提交的 DTO，执行更新或创建
        for (const productDto of newProductsDto) {
            // [核心假定] productDto.id 是从前端传递过来的
            const existingProduct = productDto.id ? existingProductsMap.get(productDto.id) : undefined;

            if (existingProduct) {
                // 4a. 更新现有产品 (ID匹配成功)
                await tx.product.update({
                    where: { id: existingProduct.id },
                    data: {
                        name: productDto.name, // 允许修改名称
                        baseDoughWeight: new Prisma.Decimal(productDto.weight),
                        procedure: productDto.procedure,
                        deletedAt: null, // [核心修改] 确保如果产品是重新添加的（或之前是软删除的），恢复其状态
                    },
                });
                // 同步原料
                await tx.productIngredient.deleteMany({ where: { productId: existingProduct.id } });
                await this._createProductIngredients(tenantId, existingProduct.id, productDto, tx);
            } else {
                // 4b. 创建新产品 (没有 ID 或 ID 不匹配)
                const newProduct = await tx.product.create({
                    data: {
                        recipeVersionId: versionId,
                        name: productDto.name,
                        baseDoughWeight: new Prisma.Decimal(productDto.weight),
                        procedure: productDto.procedure,
                        // deletedAt 默认为 null
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
                    // [核心修正] 检查是否存在同名的孤立原料
                    const existingIngredient = await tx.ingredient.findFirst({
                        where: {
                            tenantId,
                            name: name,
                            deletedAt: null,
                        },
                        select: { id: true },
                    });

                    // 无论如何都创建配方族
                    recipeFamily = await tx.recipeFamily.create({
                        data: { name, tenantId, type, category: finalCategory },
                        include: { versions: true },
                    });

                    // [核心修正] 如果确实存在同名原料，则执行数据迁移
                    if (existingIngredient) {
                        const newFamilyId = recipeFamily.id;
                        const oldIngredientId = existingIngredient.id;

                        // 1. 迁移 ComponentIngredient (如果新配方是面种)
                        // 这会将所有之前错误关联到“原料”上的面种，转为关联到新的“面种配方”
                        if (type === 'PRE_DOUGH') {
                            await tx.componentIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    linkedPreDoughId: newFamilyId,
                                },
                            });
                        }

                        // 2. 迁移 ProductIngredient (如果新配方是馅料/装饰)
                        // 这会将所有之前错误关联到“原料”上的馅料/装饰，转为关联到新的“附加项配方”
                        if (type === 'EXTRA') {
                            await tx.productIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    linkedExtraId: newFamilyId,
                                },
                            });
                        }

                        // 3. 软删除已迁移的孤立原料
                        // 这样它就不会再出现在 `ingredients.service.ts` 的查询中（即使没有notIn逻辑）
                        // 也不会在 `_ensureIngredientsExist` 中被找到
                        await tx.ingredient.update({
                            where: { id: oldIngredientId },
                            data: {
                                deletedAt: new Date(),
                            },
                        });
                    }
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

                const finalFamily = await this.createVersionContents(tenantId, recipeVersion.id, createRecipeDto, tx);
                return this._sanitizeFamily(finalFamily);
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
            divisionLoss,
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
        const divisionLossForDb =
            divisionLoss === null || divisionLoss === undefined ? undefined : new Prisma.Decimal(divisionLoss);

        const component = await tx.recipeComponent.create({
            data: {
                recipeVersionId: versionId,
                name: name,
                targetTemp: type === 'MAIN' ? targetTempForDb : undefined,
                lossRatio: lossRatioForDb,
                divisionLoss: divisionLossForDb,
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

        const version = await tx.recipeVersion.findUnique({ where: { id: versionId } });
        return tx.recipeFamily.findUnique({
            where: { id: version?.familyId },
            include: recipeFamilyWithDetailsInclude,
        });
    }

    private async _ensureIngredientsExist(tenantId: string, recipeDto: CreateRecipeDto, tx: Prisma.TransactionClient) {
        const { ingredients, products } = recipeDto;
        const allRawIngredients = [
            ...ingredients,
            ...(products ?? []).flatMap((p) => [...(p.mixIn ?? []), ...(p.fillings ?? []), ...(p.toppings ?? [])]),
        ];

        const newIngredientNames = new Set<string>();

        for (const ing of allRawIngredients) {
            newIngredientNames.add(ing.name);
        }

        const existingIngredients = await tx.ingredient.findMany({
            where: {
                tenantId,
                name: { in: Array.from(newIngredientNames) },
                deletedAt: null, // [核心修正] 确保我们只查找未被软删除的原料
            },
        });

        const existingIngredientMap = new Map<string, Ingredient | Prisma.IngredientCreateManyInput>(
            existingIngredients.map((i) => [i.name, i]),
        );

        const existingFamilies = await tx.recipeFamily.findMany({
            where: {
                tenantId,
                name: { in: Array.from(newIngredientNames) },
                type: { in: ['PRE_DOUGH', 'EXTRA'] },
                deletedAt: null, // [核心修正] 确保我们只查找未被软删除的配方
            },
        });
        const existingFamilyNames = new Set(existingFamilies.map((f) => f.name));

        const ingredientsToCreate: Prisma.IngredientCreateManyInput[] = [];

        for (const ing of allRawIngredients) {
            if (existingIngredientMap.has(ing.name) || existingFamilyNames.has(ing.name)) {
                const existing = existingIngredientMap.get(ing.name);
                if (existing && 'id' in existing) {
                    ing.ingredientId = existing.id;
                }
                continue;
            }
            const isWater = ing.name === '水';

            const waterContentForDb = isWater ? 1 : 'waterContent' in ing ? (ing.waterContent ?? 0) : 0;
            const newIngredientData: Prisma.IngredientCreateManyInput = {
                tenantId,
                name: ing.name,
                type: isWater ? IngredientType.UNTRACKED : IngredientType.STANDARD,
                isFlour: isWater ? false : 'isFlour' in ing ? (ing.isFlour ?? false) : false,
                waterContent: new Prisma.Decimal(waterContentForDb),
            };
            ingredientsToCreate.push(newIngredientData);
            existingIngredientMap.set(ing.name, newIngredientData);
        }

        if (ingredientsToCreate.length > 0) {
            await tx.ingredient.createMany({
                data: ingredientsToCreate,
                skipDuplicates: true,
            });
            const createdIngredients = await tx.ingredient.findMany({
                where: {
                    tenantId,
                    name: { in: ingredientsToCreate.map((i) => i.name) },
                },
            });
            for (const created of createdIngredients) {
                existingIngredientMap.set(created.name, created);
            }
        }

        for (const ing of allRawIngredients) {
            if ('ingredientId' in ing && !existingFamilyNames.has(ing.name)) {
                const existing = existingIngredientMap.get(ing.name);
                if (existing && 'id' in existing) {
                    ing.ingredientId = existing.id;
                }
            }
        }
    }

    async findAll(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                deletedAt: null, // [核心修改] 只查找未弃用的配方
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: {
                            where: { deletedAt: null }, // [核心修改] 只包括未软删除的产品
                        },
                        components: {
                            include: {
                                _count: {
                                    select: { ingredients: true },
                                },
                            },
                        },
                    },
                },
                _count: {
                    select: {
                        usedInComponents: true,
                        usedInProducts: true,
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

                const usageCount = (family._count?.usedInComponents || 0) + (family._count?.usedInProducts || 0);

                if (family.type !== 'MAIN') {
                    return { ...family, ingredientCount, usageCount, productionTaskCount: 0 };
                }

                if (!activeVersion || activeVersion.products.length === 0) {
                    return { ...family, productCount, ingredientCount, productionTaskCount: 0, usageCount };
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
                    usageCount,
                };
            }),
        );

        // [核心修正] 在此进行局部的、专门的数据转换，而不是调用通用的 _sanitizeFamily
        const sanitizedFamilies = familiesWithCounts.map((family) => {
            return {
                ...family,
                versions: family.versions.map((v) => ({
                    ...v,
                    products: v.products.map((p) => ({
                        ...p,
                        baseDoughWeight: p.baseDoughWeight.toNumber(),
                    })),
                })),
            };
        });

        const mainRecipes = sanitizedFamilies
            .filter((family) => family.type === 'MAIN')
            .sort((a, b) => (b.productionTaskCount || 0) - (a.productionTaskCount || 0));

        const preDoughs = sanitizedFamilies
            .filter((family) => family.type === 'PRE_DOUGH')
            .sort((a, b) => a.name.localeCompare(b.name));

        const extras = sanitizedFamilies
            .filter((family) => family.type === 'EXTRA')
            .sort((a, b) => a.name.localeCompare(b.name));

        return {
            mainRecipes,
            preDoughs,
            extras,
        };
    }

    async findProductsForTasks(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                type: 'MAIN',
                deletedAt: null, // [核心修改]
                versions: {
                    some: {
                        isActive: true,
                        products: {
                            some: {
                                deletedAt: null, // [核心修改] 确保版本下有未删除的产品
                            },
                        },
                    },
                },
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: {
                            where: { deletedAt: null }, // [核心修改] 只拉取未删除的产品
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
                    // [核心修正] 增加一个安全检查，如果活跃版本没有产品
                    return {
                        ...family,
                        productionTaskCount: 0,
                    };
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
                deletedAt: null, // [核心修改] 确保不能访问已弃用的配方
            },
            include: recipeFamilyWithDetailsInclude,
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        const processedFamily = {
            ...family,
            versions: family.versions.map((version) => {
                return {
                    ...version,
                    components: version.components.map((component) => {
                        const { cleanedProcedure, ingredientNotes } = this._processProcedureNotes(component.procedure);

                        return {
                            ...component,
                            procedure: cleanedProcedure,
                            ingredients: component.ingredients.map((ing) => {
                                if (ing.ingredient) {
                                    const extraInfo = ingredientNotes.get(ing.ingredient.name);
                                    return {
                                        ...ing,
                                        ingredient: {
                                            ...ing.ingredient,
                                            extraInfo: extraInfo || undefined,
                                        },
                                    };
                                }
                                if (ing.linkedPreDough) {
                                    const extraInfo = ingredientNotes.get(ing.linkedPreDough.name);
                                    return {
                                        ...ing,
                                        linkedPreDough: {
                                            ...ing.linkedPreDough,
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

        return this._sanitizeFamily(processedFamily as RecipeFamilyWithDetails);
    }

    private _processProcedureNotes(procedure: string[] | undefined | null): {
        cleanedProcedure: string[];
        ingredientNotes: Map<string, string>;
    } {
        if (!procedure) {
            return { cleanedProcedure: [], ingredientNotes: new Map() };
        }

        const ingredientNotes = new Map<string, string>();
        const noteRegex = /@(?:\[)?(.*?)(?:\])?[(（](.*?)[)）]/g;

        const cleanedProcedure = procedure
            .map((step) => {
                const stepMatches = [...step.matchAll(noteRegex)];
                for (const match of stepMatches) {
                    const [, ingredientName, note] = match;
                    if (ingredientName && note) {
                        ingredientNotes.set(ingredientName.trim(), note.trim());
                    }
                }

                const cleanedStep = step.replace(noteRegex, '').trim();

                if (cleanedStep === '') {
                    return null;
                }
                return cleanedStep;
            })
            .filter((step): step is string => step !== null);

        return { cleanedProcedure, ingredientNotes };
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
                family: {
                    tenantId,
                    deletedAt: null, // [核心修改] 确保配方族未被弃用
                },
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
                    where: { deletedAt: null }, // [核心修改] 只加载未软删除的产品
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

            // [核心修改] 调用排序
            const sortedIngredients = this._sortIngredients(
                componentSource.ingredients,
                version.family.category,
                version.family.type,
            );

            const baseComponent: ComponentTemplate = {
                id: componentSource.id,
                name: componentSource.name,
                type: 'BASE_COMPONENT',
                lossRatio: toCleanPercent(componentSource.lossRatio) ?? undefined,
                divisionLoss: componentSource.divisionLoss?.toNumber(),
                // [核心修改] 使用 sortedIngredients
                ingredients: sortedIngredients.map((ing) => ({
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

            // [核心修改] 调用排序
            const sortedIngredients = this._sortIngredients(
                mainComponentSource.ingredients,
                version.family.category,
                version.family.type,
            );

            // [核心修改] 使用 sortedIngredients
            for (const ing of sortedIngredients) {
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
                divisionLoss: mainComponentSource.divisionLoss?.toNumber(),
                ingredients: mainComponentIngredientsForForm,
                procedure: mainComponentSource.procedure || [],
            };
            componentsForForm = [mainComponentForForm, ...preDoughComponentsForForm];
        } else {
            const componentSource = version.components[0];
            if (!componentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少组件');
            }

            // [核心修改] 调用排序
            const sortedIngredients = this._sortIngredients(
                componentSource.ingredients,
                version.family.category,
                version.family.type,
            );

            const baseComponent: ComponentTemplate = {
                id: componentSource.id,
                name: componentSource.name,
                type: 'BASE_COMPONENT',
                lossRatio: toCleanPercent(componentSource.lossRatio) ?? undefined,
                divisionLoss: componentSource.divisionLoss?.toNumber(),
                // [核心修改] 使用 sortedIngredients
                ingredients: sortedIngredients.map((ing) => ({
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
                // [核心修改] 修复 Prettier 格式
                const processIngredients = (type: ProductIngredientType) => {
                    return (
                        p.ingredients
                            .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                            // [核心修改] 按用量排序 (Rule 2)
                            .sort((a, b) => {
                                const aWeight = a.weightInGrams ? new Prisma.Decimal(a.weightInGrams).toNumber() : 0;
                                const bWeight = b.weightInGrams ? new Prisma.Decimal(b.weightInGrams).toNumber() : 0;
                                if (aWeight !== 0 || bWeight !== 0) {
                                    return bWeight - aWeight; // 优先按克重
                                }
                                const aRatio = a.ratio ? new Prisma.Decimal(a.ratio).toNumber() : 0;
                                const bRatio = b.ratio ? new Prisma.Decimal(b.ratio).toNumber() : 0;
                                return bRatio - aRatio; // 其次按比例
                            })
                            .map((ing) => {
                                const name = ing.ingredient?.name || ing.linkedExtra?.name || '';
                                // [核心修改] 修复 Prettier 格式
                                return {
                                    id: ing.ingredient?.id || ing.linkedExtra?.id || null,
                                    name,
                                    ratio: toCleanPercent(ing.ratio),
                                    weightInGrams: ing.weightInGrams?.toNumber(),
                                    isRecipe: !!ing.linkedExtra,
                                    isFlour: ing.ingredient?.isFlour ?? false,
                                    waterContent: ing.ingredient?.waterContent.toNumber() ?? 0,
                                };
                            })
                    );
                };
                return {
                    id: p.id, // [核心修改] 传递产品ID到前端
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

        // [核心修改] 更新检查逻辑，因为产品现在是软删除的
        // 我们只检查是否有 *任何* 任务项，因为 `onDelete: Restrict` 会阻止删除
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
                // [核心修改] 更新错误信息
                throw new BadRequestException('该配方已被生产任务使用，无法（物理）删除。请改用“弃用”操作。');
            }
        }

        // [核心修改] 此处是物理删除，只有在 taskCount 为 0 时才能执行
        // 由于 schema 中设置了级联删除，这将删除所有 versions, components, products
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
                deletedAt: null, // [核心修改] 确保只查找未弃用的
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
