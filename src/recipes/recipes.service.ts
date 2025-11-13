// 路径: src/recipes/recipes.service.ts

import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
    ForbiddenException,
} from '@nestjs/common';
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
    BatchComponentIngredientDto,
    BatchProductDto,
} from './dto/batch-import-recipe.dto';

const componentIngredientWithLinksInclude = {
    ingredient: true,
    linkedPreDough: true, // 关联 preDoughId
    linkedExtra: true, // 关联 extraId
} satisfies Prisma.ComponentIngredientInclude;

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

type PreloadedRecipeFamily = RecipeFamily & {
    versions: (RecipeVersion & {
        components: (RecipeComponent & {
            ingredients: (ComponentIngredient & {
                ingredient: Ingredient | null;
            })[];
        })[];
    })[];
};

export interface DisplayIngredient {
    id: string;
    name: string;
    tenantId: string;
    type: IngredientType | RecipeType;
    category?: RecipeCategory; // 来自 RecipeFamily
    isFlour: boolean;
    waterContent: number;
    currentStockInGrams: number;
    currentStockValue: number;
    activeSkuId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    extraInfo?: string;
}

type IngredientWithExtra = Ingredient & { extraInfo?: string };
type RecipeFamilyWithExtra = RecipeFamily & { extraInfo?: string };

const recipeFamilyWithDetailsInclude = {
    versions: {
        include: {
            components: {
                include: {
                    ingredients: {
                        include: componentIngredientWithLinksInclude, // 使用新 include
                    },
                },
            },
            products: {
                where: { deletedAt: null },
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

const recipeFamilyForExportInclude = {
    versions: {
        include: {
            components: {
                include: {
                    ingredients: {
                        include: componentIngredientWithLinksInclude, // 使用新 include
                    },
                },
            },
            products: {
                where: { deletedAt: null },
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
        orderBy: { version: 'asc' }, // 按版本升序导出
    },
} satisfies Prisma.RecipeFamilyInclude;

type RecipeFamilyForExport = Prisma.RecipeFamilyGetPayload<{
    include: typeof recipeFamilyForExportInclude;
}>;
type RecipeVersionForExport = RecipeFamilyForExport['versions'][0];
type ComponentIngredientForExport = RecipeVersionForExport['components'][0]['ingredients'][0];

@Injectable()
export class RecipesService {
    constructor(private prisma: PrismaService) {}

    private _sortIngredients<
        T extends Prisma.ComponentIngredientGetPayload<{
            include: {
                ingredient: true;
                linkedPreDough: true;
                linkedExtra: true; // 增加新约束
            };
        }>,
    >(ingredients: T[], category: RecipeCategory, type: RecipeType): T[] {
        // 规则1：面包类 和 面种类 应用面粉优先排序
        const isFlourSort = type === 'PRE_DOUGH' || category === 'BREAD';

        return ingredients.sort((a, b) => {
            // 1. 优先排序面种 (linkedPreDough)
            // linkedExtra (馅料) 不参与优先排序，它们应按用量排
            const aIsPreDough = !!a.preDoughId;
            const bIsPreDough = !!b.preDoughId;
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

    private _sanitizeFamily(family: RecipeFamilyWithDetails | null) {
        if (!family) {
            return null;
        }
        return {
            ...family,
            versions: family.versions.map((version) => ({
                ...version,
                components: version.components.map((component) => {
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
                        ingredients: sortedIngredients.map((componentIngredient) => {
                            let displayIngredient: DisplayIngredient | null = null;

                            if (componentIngredient.ingredient) {
                                // 1. 这是一个标准原料 (如 "面粉")
                                const ingWithExtra = componentIngredient.ingredient as IngredientWithExtra;
                                displayIngredient = {
                                    ...ingWithExtra,
                                    waterContent: ingWithExtra.waterContent.toNumber(),
                                    currentStockInGrams: ingWithExtra.currentStockInGrams.toNumber(),
                                    currentStockValue: ingWithExtra.currentStockValue.toNumber(),
                                };
                            } else if (componentIngredient.linkedPreDough) {
                                // 2. 这是一个面种配方 (如 "烫种")
                                const preDoughWithExtra = componentIngredient.linkedPreDough as RecipeFamilyWithExtra;
                                displayIngredient = {
                                    ...preDoughWithExtra,
                                    extraInfo: preDoughWithExtra.extraInfo,
                                    // 补全 Ingredient 对象的字段
                                    waterContent: 0,
                                    currentStockInGrams: 0,
                                    currentStockValue: 0,
                                    isFlour: false, // 配方本身不是面粉
                                    activeSkuId: null,
                                };
                            } else if (componentIngredient.linkedExtra) {
                                // 3. 这是一个馅料配方 (如 "卡仕达酱")
                                const extraWithExtra = componentIngredient.linkedExtra as RecipeFamilyWithExtra;
                                displayIngredient = {
                                    ...extraWithExtra,
                                    extraInfo: extraWithExtra.extraInfo,
                                    // 补全 Ingredient 对象的字段
                                    waterContent: 0,
                                    currentStockInGrams: 0,
                                    currentStockValue: 0,
                                    isFlour: false,
                                    activeSkuId: null,
                                };
                            } else {
                                // 4. 兜底处理“双 null”的坏数据
                                displayIngredient = {
                                    id: componentIngredient.id, // 至少给个 ID
                                    name: '!! 数据错误：未关联的原料 !!', // 显示错误信息
                                    type: IngredientType.STANDARD,
                                    isFlour: false,
                                    waterContent: 0,
                                    activeSkuId: null,
                                    currentStockInGrams: 0,
                                    currentStockValue: 0,
                                    createdAt: new Date(),
                                    updatedAt: new Date(),
                                    deletedAt: null,
                                    tenantId: family.tenantId, // 补充一个 tenantId
                                };
                            }
                            // eslint-disable-next-line @typescript-eslint/no-unused-vars
                            const { ingredient, linkedPreDough, linkedExtra, ...rest } = componentIngredient;

                            return {
                                ...rest,
                                ratio: componentIngredient.ratio?.toNumber(),
                                flourRatio: componentIngredient.flourRatio?.toNumber(),
                                ingredient: displayIngredient,
                            };
                        }),
                    };
                }),
                products: version.products.map((product) => ({
                    ...product,
                    baseDoughWeight: product.baseDoughWeight.toNumber(),
                    ingredients: product.ingredients.map((productIngredient) => {
                        let displayProductIngredient: DisplayIngredient | null = null;
                        if (productIngredient.ingredient) {
                            // 1. 这是一个标准原料 (如 "黄油")
                            displayProductIngredient = {
                                ...productIngredient.ingredient,
                                waterContent: productIngredient.ingredient.waterContent.toNumber(),
                                currentStockInGrams: productIngredient.ingredient.currentStockInGrams.toNumber(),
                                currentStockValue: productIngredient.ingredient.currentStockValue.toNumber(),
                            };
                        } else if (productIngredient.linkedExtra) {
                            // 2. 这是一个附加项配方 (如 "卡仕达酱")
                            displayProductIngredient = {
                                ...productIngredient.linkedExtra, // 包含 id, name
                                waterContent: 0,
                                currentStockInGrams: 0,
                                currentStockValue: 0,
                                isFlour: false,
                                activeSkuId: null,
                            };
                        } else {
                            // 3. 兜底
                            displayProductIngredient = {
                                id: productIngredient.id,
                                name: '!! 数据错误：未关联的原料 !!',
                                type: IngredientType.STANDARD,
                                isFlour: false,
                                waterContent: 0,
                                activeSkuId: null,
                                currentStockInGrams: 0,
                                currentStockValue: 0,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                                deletedAt: null,
                                tenantId: family.tenantId,
                            };
                        }
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        const { ingredient, linkedExtra, ...rest } = productIngredient;

                        return {
                            ...rest,
                            ratio: productIngredient.ratio?.toNumber(),
                            weightInGrams: productIngredient.weightInGrams?.toNumber(),
                            ingredient: displayProductIngredient,
                        };
                    }),
                })),
            })),
        };
    }

    async batchImportRecipes(
        userId: string,
        recipesDto: BatchImportRecipeDto[], // 使用新的 Family DTO
        tenantIds?: string[],
    ): Promise<BatchImportResultDto> {
        let targetTenants: { id: string; name: string }[];

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
            totalCount: recipesDto.length * targetTenants.length, // totalCount 语义变为 "总配方族数"
            importedCount: 0,
            skippedCount: 0,
            skippedRecipes: [],
        };

        // 2. 遍历所有目标店铺
        for (const tenant of targetTenants) {
            const tenantId = tenant.id;
            const tenantName = tenant.name;

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

                    const convertVersionToCreateDto = (versionDto: BatchImportVersionDto): CreateRecipeDto => {
                        return {
                            name: recipeDto.name,
                            type: recipeDto.type,
                            category: recipeDto.category,
                            notes: versionDto.notes, //
                            targetTemp: versionDto.targetTemp, //
                            lossRatio: versionDto.lossRatio, //
                            divisionLoss: versionDto.divisionLoss, //
                            procedure: versionDto.procedure, //
                            ingredients: versionDto.ingredients.map(
                                (ing: BatchComponentIngredientDto): ComponentIngredientDto => ({
                                    ...ing, //
                                    ingredientId: undefined,
                                }),
                            ),
                            products: versionDto.products?.map(
                                (p: BatchProductDto): ProductDto => ({
                                    ...p, // 包含 name, weight, procedure
                                    id: undefined,
                                    mixIn:
                                        p.mixIn?.map(
                                            (i): ProductIngredientDto => ({
                                                ...i, //
                                                type: ProductIngredientType.MIX_IN,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                    fillings:
                                        p.fillings?.map(
                                            (i): ProductIngredientDto => ({
                                                ...i, //
                                                type: ProductIngredientType.FILLING,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                    toppings:
                                        p.toppings?.map(
                                            (i): ProductIngredientDto => ({
                                                ...i, //
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

                        for (const versionDto of recipeDto.versions) {
                            const createDto = convertVersionToCreateDto(versionDto);

                            if (familyId === null) {
                                // 第一个版本：调用 this.create() 创建 Family 和 V1
                                const createdFamily = await this.create(tenantId, createDto);

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

                        for (const versionDto of recipeDto.versions) {
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

    async exportRecipes(tenantId: string, userId: string): Promise<BatchImportRecipeDto[]> {
        // 1. 权限检查：确认该用户是该店铺的 Owner
        const tenantAccess = await this.prisma.tenantUser.findFirst({
            where: {
                tenantId: tenantId,
                userId: userId,
                role: Role.OWNER,
            },
        });

        if (!tenantAccess) {
            throw new ForbiddenException('您没有权限导出该店铺的配方。');
        }

        // 2. 查找该店铺的所有配方族，并包含所有版本和详情
        const families = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId: tenantId,
                deletedAt: null, // 只导出未弃用的
            },
            include: recipeFamilyForExportInclude,
        });

        // 3. 将 Prisma 模型 转换为 离线工具/导入 DTO 所需的 JSON 结构
        const exportableFamilies: BatchImportRecipeDto[] = families.map((family) => {
            const exportableVersions = family.versions.map((version) =>
                // 调用私有辅助方法
                this._exportVersion(version, family.type),
            );

            return {
                name: family.name,
                type: family.type,
                category: family.category,
                versions: exportableVersions,
            };
        });

        return exportableFamilies;
    }

    private _exportVersion(version: RecipeVersionForExport, familyType: RecipeType): BatchImportVersionDto {
        // 辅助函数：将 Prisma.Decimal 转换为 number (小数)
        const toNum = (val: Prisma.Decimal | null | undefined): number | undefined => {
            if (val === null || val === undefined) return undefined;
            return val.toNumber();
        };

        // 辅助函数：格式化组件原料
        const formatComponentIngredient = (ing: ComponentIngredientForExport): BatchComponentIngredientDto | null => {
            // 检查 linkedPreDough (使用 ing.linkedPreDough 而非 ing.preDoughId)
            if (ing.linkedPreDough) {
                // 这是一个面种
                return {
                    name: ing.linkedPreDough.name,
                    flourRatio: toNum(ing.flourRatio), // 导出小数
                };
            }
            // 检查 linkedExtra (使用 ing.linkedExtra 而非 ing.extraId)
            if (ing.linkedExtra) {
                // 这是一个馅料
                return {
                    name: ing.linkedExtra.name,
                    ratio: toNum(ing.ratio), // 导出小数
                };
            }
            // 检查 ingredient (使用 ing.ingredient 而非 ing.ingredientId)
            if (ing.ingredient) {
                // 这是一个标准原料
                const result: BatchComponentIngredientDto = {
                    name: ing.ingredient.name,
                    ratio: toNum(ing.ratio), // 导出小数
                };
                if (ing.ingredient.isFlour) {
                    result.isFlour = true;
                }
                if (ing.ingredient.waterContent.gt(0)) {
                    result.waterContent = ing.ingredient.waterContent.toNumber();
                }
                return result;
            }
            return null;
        };

        if (familyType === 'MAIN') {
            const mainComponent = version.components[0]; // 假设 MAIN 总是 [0]
            if (!mainComponent) {
                return { notes: version.notes || '', ingredients: [], products: [] };
            }

            const finalIngredients = mainComponent.ingredients
                .map(formatComponentIngredient)
                .filter((ing): ing is BatchComponentIngredientDto => !!ing);

            return {
                notes: version.notes || '',
                targetTemp: toNum(mainComponent.targetTemp),
                lossRatio: toNum(mainComponent.lossRatio),
                divisionLoss: toNum(mainComponent.divisionLoss),
                procedure: mainComponent.procedure,
                ingredients: finalIngredients,
                products: version.products.map((p) => {
                    return {
                        name: p.name,
                        weight: p.baseDoughWeight.toNumber(),
                        procedure: p.procedure,
                        mixIn: p.ingredients
                            .filter((i) => i.type === 'MIX_IN' && (i.ingredient || i.linkedExtra))
                            .map((i) => ({
                                name: i.ingredient?.name || i.linkedExtra!.name, // 已在 filter 中检查
                                ratio: toNum(i.ratio),
                            })),
                        fillings: p.ingredients
                            .filter((i) => i.type === 'FILLING' && (i.ingredient || i.linkedExtra))
                            .map((i) => ({
                                name: i.ingredient?.name || i.linkedExtra!.name,
                                weightInGrams: toNum(i.weightInGrams),
                            })),
                        toppings: p.ingredients
                            .filter((i) => i.type === 'TOPPING' && (i.ingredient || i.linkedExtra))
                            .map((i) => ({
                                name: i.ingredient?.name || i.linkedExtra!.name,
                                weightInGrams: toNum(i.weightInGrams),
                            })),
                    };
                }),
            };
        } else {
            // PRE_DOUGH 或 EXTRA
            const component = version.components[0];
            if (!component) {
                return { notes: version.notes || '', ingredients: [], products: [] };
            }

            return {
                notes: version.notes || '',
                lossRatio: toNum(component.lossRatio),
                procedure: component.procedure,
                ingredients: component.ingredients
                    .map(formatComponentIngredient)
                    .filter((ing): ing is BatchComponentIngredientDto => !!ing),
                products: [], // 非 MAIN 配方没有产品
            };
        }
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
                    where: { deletedAt: null }, // 只包括未软删除的产品
                },
            },
        });

        if (!versionToUpdate) {
            throw new NotFoundException('指定的配方版本不存在');
        }

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

            // 预加载所有引用的配方 (PRE_DOUGH 或 EXTRA)
            const linkedFamilies = await this.preloadLinkedFamilies(tenantId, ingredients, tx);

            // 在计算比例前，进行循环引用和自引用检查
            await this._validateCircularReference(familyId, updateRecipeDto.name, ingredients, linkedFamilies, tx);

            // 验证比例并计算总 ratio
            this.calculateAndValidateLinkedFamilyRatios(type, ingredients, linkedFamilies);

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
                const linkedFamily = linkedFamilies.get(ingredientDto.name);

                // 确定是哪种引用
                const ingredientId = linkedFamily ? undefined : ingredientDto.ingredientId;
                const preDoughId = linkedFamily?.type === 'PRE_DOUGH' ? linkedFamily.id : undefined;
                const extraId = linkedFamily?.type === 'EXTRA' ? linkedFamily.id : undefined;

                if (!ingredientId && !preDoughId && !extraId) {
                    throw new BadRequestException(
                        `原料 "${ingredientDto.name}" 无法被识别，它既不是标准原料，也不是一个有效的 PRE_DOUGH 或 EXTRA 配方。`,
                    );
                }

                const ratioForDb =
                    ingredientDto.ratio === null || ingredientDto.ratio === undefined
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
                        ingredientId: ingredientId,
                        preDoughId: preDoughId, // 新字段
                        extraId: extraId, // 新字段
                    },
                });
            }

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

    private async _syncProductsForVersion(
        tenantId: string,
        versionId: string,
        existingProducts: Product[],
        newProductsDto: ProductDto[],
        tx: Prisma.TransactionClient,
    ) {
        const existingProductsMap = new Map(existingProducts.map((p) => [p.id, p]));
        const newProductIds = new Set(newProductsDto.filter((p) => p.id).map((p) => p.id!));

        // 1. 找出需要软删除的产品
        const productsToSoftDelete = existingProducts.filter((p) => !newProductIds.has(p.id));

        if (productsToSoftDelete.length > 0) {
            const productIdsToSoftDelete = productsToSoftDelete.map((p) => p.id);

            // 2. 检查这些产品是否在 "待开始" 或 "进行中" 的任务里
            const usageCount = await tx.productionTaskItem.count({
                where: {
                    productId: { in: productIdsToSoftDelete },
                    // 只检查 "待开始" 和 "进行中" 的任务
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
        }

        // 4. 遍历提交的 DTO，执行更新或创建
        for (const productDto of newProductsDto) {
            const existingProduct = productDto.id ? existingProductsMap.get(productDto.id) : undefined;

            if (existingProduct) {
                // 4a. 更新现有产品 (ID匹配成功)
                await tx.product.update({
                    where: { id: existingProduct.id },
                    data: {
                        name: productDto.name, // 允许修改名称
                        baseDoughWeight: new Prisma.Decimal(productDto.weight),
                        procedure: productDto.procedure,
                        deletedAt: null, // 确保如果产品是重新添加的（或之前是软删除的），恢复其状态
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
            // 查找 EXTRA 配方 (这部分逻辑保持不变)
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
                    recipeFamily = existingFamily as RecipeFamilyWithVersions; // 类型断言
                } else {
                    // 检查是否存在同名的孤立原料
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

                    // 如果确实存在同名原料，则执行数据迁移
                    if (existingIngredient) {
                        const newFamilyId = recipeFamily.id;
                        const oldIngredientId = existingIngredient.id;

                        // 迁移 ComponentIngredient
                        // 根据新 schema，需要判断是 PRE_DOUGH 还是 EXTRA
                        if (type === 'PRE_DOUGH') {
                            // 这会将所有之前错误关联到“原料”上的面种，转为关联到新的“面种配方”
                            await tx.componentIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    preDoughId: newFamilyId, // 使用新字段
                                },
                            });
                        } else if (type === 'EXTRA') {
                            // 这会将所有之前错误关联到“原料”上的馅料，转为关联到新的“附加项配方”
                            await tx.componentIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    extraId: newFamilyId, // 使用新字段
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
                        await tx.ingredient.update({
                            where: { id: oldIngredientId },
                            data: {
                                deletedAt: new Date(),
                            },
                        });
                    }
                }

                const hasActiveVersion = recipeFamily.versions.some((v: RecipeVersion) => v.isActive);
                const nextVersionNumber =
                    recipeFamily.versions.length > 0
                        ? Math.max(...recipeFamily.versions.map((v: RecipeVersion) => v.version)) + 1
                        : 1;

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

        // 预加载所有引用的配方 (PRE_DOUGH 或 EXTRA)
        const linkedFamilies = await this.preloadLinkedFamilies(tenantId, ingredients, tx);

        // 获取父配方信息以进行循环引用检查
        const parentVersion = await tx.recipeVersion.findUnique({
            where: { id: versionId },
            include: { family: { select: { id: true, name: true } } },
        });
        if (!parentVersion) {
            throw new NotFoundException('无法找到配方版本');
        }
        const parentFamilyId = parentVersion.family.id;
        const parentRecipeName = parentVersion.family.name;

        // 进行循环引用和自引用检查
        await this._validateCircularReference(parentFamilyId, parentRecipeName, ingredients, linkedFamilies, tx);

        // 验证比例并计算总 ratio
        this.calculateAndValidateLinkedFamilyRatios(type, ingredients, linkedFamilies);

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
            const linkedFamily = linkedFamilies.get(ingredientDto.name);

            // 确定是哪种引用
            const ingredientId = linkedFamily ? undefined : ingredientDto.ingredientId;
            const preDoughId = linkedFamily?.type === 'PRE_DOUGH' ? linkedFamily.id : undefined;
            const extraId = linkedFamily?.type === 'EXTRA' ? linkedFamily.id : undefined;

            if (!ingredientId && !preDoughId && !extraId) {
                // 兜底检查，如果 _ensureIngredientsExist 失败
                throw new BadRequestException(
                    `原料 "${ingredientDto.name}" 无法被识别，它既不是标准原料，也不是一个有效的 PRE_DOUGH 或 EXTRA 配方。`,
                );
            }

            // `ingredientDto.ratio` 此时可能已被 `calculate...` 方法重写
            const ratioForDb =
                ingredientDto.ratio === null || ingredientDto.ratio === undefined
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
                    ingredientId: ingredientId,
                    preDoughId: preDoughId, // 新字段
                    extraId: extraId, // 新字段
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

        return tx.recipeFamily.findUnique({
            where: { id: parentFamilyId },
            include: recipeFamilyWithDetailsInclude,
        });
    }

    private async _ensureIngredientsExist(tenantId: string, recipeDto: CreateRecipeDto, tx: Prisma.TransactionClient) {
        const { ingredients, products } = recipeDto;
        const allRawIngredients = [
            ...ingredients,
            ...(products ?? []).flatMap((p) => [...(p.mixIn ?? []), ...(p.fillings ?? []), ...(p.toppings ?? [])]),
        ];

        const allIngredientNames = Array.from(new Set(allRawIngredients.map((ing) => ing.name)));

        if (allIngredientNames.length === 0) {
            return;
        }

        // 1. 一次性获取所有已存在的原料 (Ingredients)
        const existingIngredients = await tx.ingredient.findMany({
            where: {
                tenantId,
                name: { in: allIngredientNames },
                deletedAt: null,
            },
        });
        const existingIngredientMap = new Map(existingIngredients.map((i) => [i.name, i]));

        // 2. 一次性获取所有已存在的配方 (RecipeFamilies)
        // 此处查找 *所有* 类型，以防止创建同名原料
        const existingFamilies = await tx.recipeFamily.findMany({
            where: {
                tenantId,
                name: { in: allIngredientNames },
                deletedAt: null,
            },
        });
        const existingFamilyNames = new Set(existingFamilies.map((f) => f.name));

        // 3. 找出需要创建的新原料
        const ingredientsToCreate: Prisma.IngredientCreateManyInput[] = [];

        for (const name of allIngredientNames) {
            // 如果它既不是已存在原料，也不是已存在配方，那么就需要创建
            if (!existingIngredientMap.has(name) && !existingFamilyNames.has(name)) {
                const dto = allRawIngredients.find((ing) => ing.name === name); // 找到第一个 DTO 作为模板
                if (!dto) continue; // 理论上不会发生

                const isWater = name === '水';
                // 检查 DTO 是否有 isFlour 和 waterContent 属性
                const waterContentForDb = isWater ? 1 : 'waterContent' in dto ? (dto.waterContent ?? 0) : 0;
                const isFlourForDb = isWater ? false : 'isFlour' in dto ? (dto.isFlour ?? false) : false;

                const newIngredientData: Prisma.IngredientCreateManyInput = {
                    tenantId,
                    name: name,
                    type: isWater ? IngredientType.UNTRACKED : IngredientType.STANDARD,
                    isFlour: isFlourForDb,
                    waterContent: new Prisma.Decimal(waterContentForDb),
                };
                ingredientsToCreate.push(newIngredientData);
            }
        }

        // 4. 批量创建新原料
        if (ingredientsToCreate.length > 0) {
            await tx.ingredient.createMany({
                data: ingredientsToCreate,
                skipDuplicates: true,
            });

            // 5. 创建后，必须重新查询以获取新 ID，并更新 Map
            const createdIngredients = await tx.ingredient.findMany({
                where: {
                    tenantId,
                    name: { in: ingredientsToCreate.map((i) => i.name) },
                    deletedAt: null,
                },
            });
            for (const created of createdIngredients) {
                existingIngredientMap.set(created.name, created);
            }
        }

        // 6. 遍历所有 DTO，强制同步 ID
        // 这是最关键的一步，确保 DTO 上的 ID 是正确的
        for (const ing of allRawIngredients) {
            if (existingFamilyNames.has(ing.name)) {
                // 如果是配方族 (烫种, 卡仕达酱)
                // 必须清除 ID，防止客户端传入无效ID
                ing.ingredientId = undefined;
            } else {
                // 如果是原料 (面粉, 水)
                const existing = existingIngredientMap.get(ing.name);
                if (existing && 'id' in existing) {
                    // 强制使用从数据库查到的 ID
                    ing.ingredientId = existing.id;
                } else {
                    // 兜底：如果找不到（理论上不应发生），也清除 ID
                    ing.ingredientId = undefined;
                }
            }
        }
    }

    async findAll(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                deletedAt: null, // 只查找未弃用的配方
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: {
                            where: { deletedAt: null }, // 只包括未软删除的产品
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
                        usedInComponentsAsPreDough: true,
                        usedInComponentsAsExtra: true,
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

                const usageCount =
                    (family._count?.usedInComponentsAsPreDough || 0) +
                    (family._count?.usedInComponentsAsExtra || 0) +
                    (family._count?.usedInProducts || 0);

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

        // 在此进行局部的、专门的数据转换，而不是调用通用的 _sanitizeFamily
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
                deletedAt: null,
                versions: {
                    some: {
                        isActive: true,
                        products: {
                            some: {
                                deletedAt: null, // 确保版本下有未删除的产品
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
                            where: { deletedAt: null }, // 只拉取未删除的产品
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
                    // 增加一个安全检查，如果活跃版本没有产品
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
                deletedAt: null, // 确保不能访问已弃用的配方
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
                                    (ing.ingredient as IngredientWithExtra).extraInfo = extraInfo || undefined;
                                }
                                if (ing.linkedPreDough) {
                                    // 备注给 面种
                                    const extraInfo = ingredientNotes.get(ing.linkedPreDough.name);
                                    (ing.linkedPreDough as RecipeFamilyWithExtra).extraInfo = extraInfo || undefined;
                                }
                                if (ing.linkedExtra) {
                                    // 备注给 馅料
                                    const extraInfo = ingredientNotes.get(ing.linkedExtra.name);
                                    (ing.linkedExtra as RecipeFamilyWithExtra).extraInfo = extraInfo || undefined;
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
                    deletedAt: null, // 确保配方族未被弃用
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
                                    // 包含 PRE_DOUGH 引用
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
                                linkedExtra: true, // 包含 EXTRA 引用
                            },
                        },
                    },
                },
                products: {
                    where: { deletedAt: null }, // 只加载未软删除的产品
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
                ingredients: sortedIngredients
                    .map((ing) => {
                        const linkedRecipe = ing.linkedPreDough || ing.linkedExtra;
                        const standardIngredient = ing.ingredient;

                        if (linkedRecipe) {
                            return {
                                id: linkedRecipe.id,
                                name: linkedRecipe.name,
                                // PRE_DOUGH 用 flourRatio, EXTRA 用 ratio
                                ratio:
                                    linkedRecipe.type === 'PRE_DOUGH'
                                        ? toCleanPercent(ing.flourRatio)
                                        : toCleanPercent(ing.ratio),
                                isRecipe: true,
                                isFlour: false, // 配方本身不是面粉
                                waterContent: 0,
                            };
                        } else if (standardIngredient) {
                            return {
                                id: standardIngredient.id,
                                name: standardIngredient.name,
                                ratio: toCleanPercent(ing.ratio),
                                isRecipe: false,
                                isFlour: standardIngredient.isFlour,
                                waterContent: standardIngredient.waterContent.toNumber(),
                            };
                        }
                        return null; // 理论上不应发生
                    })
                    .filter((i): i is NonNullable<typeof i> => i !== null),
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

        // 以下为 MAIN 类型配方
        let componentsForForm: ComponentTemplate[] = [];

        if (version.family.category === RecipeCategory.BREAD) {
            const mainComponentSource = version.components.find((c) => c.name === version.family.name);
            if (!mainComponentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少主组件');
            }

            const mainComponentIngredientsForForm: ComponentTemplate['ingredients'] = [];
            const preDoughComponentsForForm: ComponentTemplate[] = [];

            const sortedIngredients = this._sortIngredients(
                mainComponentSource.ingredients,
                version.family.category,
                version.family.type,
            );

            for (const ing of sortedIngredients) {
                if (ing.linkedPreDough) {
                    // 场景1: 这是一个 PRE_DOUGH 引用
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
                } else if (ing.ingredient) {
                    // 场景2: 这是一个标准原料
                    mainComponentIngredientsForForm.push({
                        id: ing.ingredient.id,
                        name: ing.ingredient.name,
                        ratio: toCleanPercent(ing.ratio),
                        isRecipe: false,
                        isFlour: ing.ingredient.isFlour,
                        waterContent: ing.ingredient.waterContent.toNumber(),
                    });
                } else if (ing.linkedExtra) {
                    // 场景3: 这是一个 EXTRA 引用 (作为主料)
                    mainComponentIngredientsForForm.push({
                        id: ing.linkedExtra.id,
                        name: ing.linkedExtra.name,
                        ratio: toCleanPercent(ing.ratio),
                        isRecipe: true,
                        isFlour: false,
                        waterContent: 0,
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
            // 非 BREAD 的 MAIN 配方
            const componentSource = version.components[0];
            if (!componentSource) {
                throw new NotFoundException('源配方数据不完整: 缺少组件');
            }

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
                ingredients: sortedIngredients
                    .map((ing) => {
                        const linkedRecipe = ing.linkedPreDough || ing.linkedExtra;
                        const standardIngredient = ing.ingredient;
                        if (linkedRecipe) {
                            return {
                                id: linkedRecipe.id,
                                name: linkedRecipe.name,
                                ratio:
                                    linkedRecipe.type === 'PRE_DOUGH'
                                        ? toCleanPercent(ing.flourRatio)
                                        : toCleanPercent(ing.ratio),
                                isRecipe: true,
                                isFlour: false,
                                waterContent: 0,
                            };
                        } else if (standardIngredient) {
                            return {
                                id: standardIngredient.id,
                                name: standardIngredient.name,
                                ratio: toCleanPercent(ing.ratio),
                                isRecipe: false,
                                isFlour: standardIngredient.isFlour,
                                waterContent: standardIngredient.waterContent.toNumber(),
                            };
                        }
                        return null;
                    })
                    .filter((i): i is NonNullable<typeof i> => i !== null),
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
                    return (
                        p.ingredients
                            .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                            // 按用量排序 (Rule 2)
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
                    id: p.id, // 传递产品ID到前端
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
                throw new BadRequestException('该配方已被生产任务使用，无法（物理）删除。请改用“弃用”操作。');
            }
        }

        // 此处是物理删除，只有在 taskCount 为 0 时才能执行
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

    private async preloadLinkedFamilies(
        tenantId: string,
        ingredients: ComponentIngredientDto[],
        tx: Prisma.TransactionClient,
    ): Promise<Map<string, PreloadedRecipeFamily>> {
        // 查找所有可能是配方引用的名称
        const linkedRecipeNames = ingredients.map((ing) => ing.name);

        if (linkedRecipeNames.length === 0) {
            return new Map();
        }

        const families = await tx.recipeFamily.findMany({
            where: {
                name: { in: linkedRecipeNames },
                tenantId,
                // 查找 PRE_DOUGH 或 EXTRA
                type: { in: ['PRE_DOUGH', 'EXTRA'] },
                deletedAt: null,
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        components: {
                            include: { ingredients: { include: { ingredient: true } } },
                        },
                    },
                },
            },
        });

        return new Map(families.map((f) => [f.name, f as PreloadedRecipeFamily]));
    }

    // 用于递归检查循环引用的辅助函数
    private async _getDescendantFamilyIds(
        familyId: string,
        tx: Prisma.TransactionClient,
        visited: Set<string>, // 使用 Set 来跟踪访问过的节点
    ): Promise<Set<string>> {
        // 1. 如果我们在此次检查中已经访问过这个节点，说明存在循环
        if (visited.has(familyId)) {
            return new Set<string>();
        }
        visited.add(familyId); // 标记当前节点为已访问

        // 2. 查找此配方激活版本的原料
        const activeVersion = await tx.recipeVersion.findFirst({
            where: { familyId: familyId, isActive: true },
            include: {
                components: {
                    include: {
                        ingredients: {
                            select: { preDoughId: true, extraId: true }, // 只需要引用的配方 ID
                        },
                    },
                },
            },
        });

        // 如果没有激活版本或没有原料，它就没有子配方
        if (!activeVersion?.components[0]) {
            return new Set<string>();
        }

        const childRecipeIds = new Set<string>();
        for (const ing of activeVersion.components[0].ingredients) {
            if (ing.preDoughId) childRecipeIds.add(ing.preDoughId);
            if (ing.extraId) childRecipeIds.add(ing.extraId);
        }

        // 3. 递归查找所有子孙配方
        const allDescendants = new Set<string>(childRecipeIds);
        for (const childId of childRecipeIds) {
            const grandChildren = await this._getDescendantFamilyIds(childId, tx, visited);
            grandChildren.forEach((gcId) => allDescendants.add(gcId));
        }

        return allDescendants;
    }

    // 检查自引用和循环引用的主函数
    private async _validateCircularReference(
        parentFamilyId: string,
        parentRecipeName: string,
        ingredients: ComponentIngredientDto[],
        linkedFamilies: Map<string, PreloadedRecipeFamily>,
        tx: Prisma.TransactionClient,
    ) {
        for (const ingredientDto of ingredients) {
            const linkedFamily = linkedFamilies.get(ingredientDto.name);
            if (!linkedFamily) continue; // 这是一个标准原料

            // 1. 检查自引用 (A -> A)
            if (linkedFamily.id === parentFamilyId) {
                throw new BadRequestException(`配方 "${parentRecipeName}" 不能引用自己作为原料。`);
            }

            // 2. 检查循环引用 (A -> B -> ... -> A)
            // 我们需要获取这个原料的所有子孙配方
            const descendants = await this._getDescendantFamilyIds(linkedFamily.id, tx, new Set<string>());

            // 如果父配方的 ID 出现在子配方的“后代”列表中，则存在循环引用
            if (descendants.has(parentFamilyId)) {
                throw new BadRequestException(
                    `循环引用：配方 "${linkedFamily.name}" 已经（或间接）引用了您正在保存的配方 "${parentRecipeName}"。`,
                );
            }
        }
    }

    private calculateAndValidateLinkedFamilyRatios(
        parentType: RecipeType, // 接收父配方类型
        ingredients: ComponentIngredientDto[],
        linkedFamilies: Map<string, PreloadedRecipeFamily>,
    ) {
        for (const ing of ingredients) {
            const linkedFamily = linkedFamilies.get(ing.name);
            if (!linkedFamily) {
                // 这是一个标准原料 (如 "面粉")
                if (ing.flourRatio !== undefined && ing.flourRatio !== null) {
                    // 业务规则：flourRatio 只能用于 PRE_DOUGH
                    throw new BadRequestException(`原料 "${ing.name}" 是一个标准原料，不能使用面粉比例(flourRatio)。`);
                }
                // ratio 正常使用，无需处理
                continue;
            }

            // 这是一个配方引用
            if (linkedFamily.type === 'PRE_DOUGH') {
                if (parentType === 'EXTRA') {
                    throw new BadRequestException(
                        `逻辑错误：配方 "${ing.name}" 是面种(PRE_DOUGH)，但当前配方是附加项(EXTRA)。附加项配方不能引用面种。`,
                    );
                }

                // 场景1: 引用 PRE_DOUGH (面种)
                if (ing.flourRatio === undefined || ing.flourRatio === null) {
                    throw new BadRequestException(
                        `配方 "${ing.name}" 是面种(PRE_DOUGH)，必须使用面粉比例(flourRatio)来引用。`,
                    );
                }
                if (ing.ratio !== undefined && ing.ratio !== null) {
                    throw new BadRequestException(`配方 "${ing.name}" 是面种(PRE_DOUGH)，不能使用常规比例(ratio)。`);
                }

                // 计算这个 PRE_DOUGH 的总 ratio，并存入 DTO
                const preDoughRecipe = linkedFamily?.versions[0]?.components[0];
                if (!preDoughRecipe) {
                    throw new BadRequestException(`名为 "${ing.name}" 的预制面团配方不存在或未激活。`);
                }

                const preDoughTotalRatioSum = preDoughRecipe.ingredients.reduce(
                    (sum, i) => sum + (i.ratio ? new Prisma.Decimal(i.ratio).toNumber() : 0),
                    0,
                );

                if (preDoughTotalRatioSum > 0) {
                    // 重写 DTO 上的 ratio，供 createVersionContents 使用
                    ing.ratio = new Prisma.Decimal(ing.flourRatio).mul(preDoughTotalRatioSum).toNumber();
                } else {
                    ing.ratio = 0;
                }
            } else {
                // 场景2: 引用 EXTRA (馅料)

                if (parentType === 'PRE_DOUGH') {
                    throw new BadRequestException(
                        `逻辑错误：配方 "${ing.name}" 是附加项(EXTRA)，但当前配方是面种(PRE_DOUGH)。面种配方不能引用附加项。`,
                    );
                }

                if (ing.ratio === undefined || ing.ratio === null) {
                    throw new BadRequestException(
                        `配方 "${ing.name}" 是附加项(EXTRA)，必须使用常规比例(ratio)来引用。`,
                    );
                }
                if (ing.flourRatio !== undefined && ing.flourRatio !== null) {
                    throw new BadRequestException(`配方 "${ing.name}" 是附加项(EXTRA)，不能使用面粉比例(flourRatio)。`);
                }
                // ratio 保持 DTO 传来的值，无需计算
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
                // 这是 PRE_DOUGH 引用
                totalFlourRatio = totalFlourRatio.add(new Prisma.Decimal(ingredientDto.flourRatio));
            } else if (ingredientDto.isFlour) {
                // 这是面粉原料
                totalFlourRatio = totalFlourRatio.add(new Prisma.Decimal(ingredientDto.ratio ?? 0));
            }
        }

        // 容差 0.1%
        if (totalFlourRatio.sub(1).abs().gt(0.001)) {
            throw new BadRequestException(
                `配方验证失败：所有面粉类原料（包括用于制作预制面团的面粉）的比例总和必须为100%。当前计算总和为: ${totalFlourRatio
                    .mul(100)
                    .toFixed(2)}%`,
            );
        }
    }
}
