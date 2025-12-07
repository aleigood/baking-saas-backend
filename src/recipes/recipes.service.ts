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

// [新增] 单一递归类型定义
type WaterCalcFamily = {
    versions: {
        isActive: boolean;
        components: {
            customWaterContent?: Prisma.Decimal | number | null;
            ingredients: {
                ratio?: Prisma.Decimal | number | null;
                ingredient?: { waterContent: Prisma.Decimal | number } | null;
                linkedPreDough?: WaterCalcFamily | null;
                linkedExtra?: WaterCalcFamily | null;
            }[];
        }[];
    }[];
};

const componentIngredientWithLinksInclude = {
    ingredient: true,
    // [核心修改] 增加 outputIngredient 关联，以便获取自制原料的保质期
    linkedPreDough: { include: { outputIngredient: true } },
    linkedExtra: { include: { outputIngredient: true } },
} satisfies Prisma.ComponentIngredientInclude;

type RecipeFamilyWithVersions = RecipeFamily & { versions: RecipeVersion[] };

// 更新 PreloadedRecipeFamily 类型以匹配 include
type PreloadedRecipeFamily = RecipeFamily & {
    versions: (RecipeVersion & {
        components: (RecipeComponent & {
            ingredients: (ComponentIngredient & {
                ingredient: Ingredient | null;
            })[];
        })[];
    })[];
    outputIngredient?: Ingredient | null;
};

export interface DisplayIngredient {
    id: string;
    name: string;
    tenantId: string;
    type: IngredientType | RecipeType;
    category?: RecipeCategory;
    isFlour: boolean;
    waterContent: number;
    currentStockInGrams: number;
    currentStockValue: number;
    activeSkuId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    extraInfo?: string;
    // [核心新增]
    shelfLife: number;
    recipeFamilyId?: string | null;
}

type IngredientWithExtra = Ingredient & { extraInfo?: string };
// RecipeFamily 包含 outputIngredient
type RecipeFamilyWithLink = RecipeFamily & { outputIngredient?: Ingredient | null; extraInfo?: string };

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
                        include: componentIngredientWithLinksInclude,
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
        orderBy: { version: 'asc' },
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

    // [核心新增] 同步维护 SELF_MADE 原料
    private async _syncSelfMadeIngredient(
        tx: Prisma.TransactionClient,
        tenantId: string,
        familyId: string,
        name: string,
        type: RecipeType,
        waterContent: number,
        shelfLife: number, // [核心新增] 保质期参数
    ) {
        // 主配方不产生原料
        if (type === 'MAIN') return;

        // 查找是否已存在关联的原料
        const existing = await tx.ingredient.findUnique({
            where: { recipeFamilyId: familyId },
        });

        if (existing) {
            // 如果名称、含水量或保质期有变化，则更新
            if (
                existing.name !== name ||
                existing.waterContent.toNumber() !== waterContent ||
                existing.shelfLife !== shelfLife
            ) {
                await tx.ingredient.update({
                    where: { id: existing.id },
                    data: {
                        name,
                        waterContent: new Prisma.Decimal(waterContent),
                        shelfLife: shelfLife,
                    },
                });
            }
        } else {
            // 如果不存在，创建新的自制原料
            await tx.ingredient.create({
                data: {
                    tenantId,
                    name,
                    type: IngredientType.SELF_MADE,
                    recipeFamilyId: familyId,
                    isFlour: false,
                    waterContent: new Prisma.Decimal(waterContent),
                    shelfLife: shelfLife,
                },
            });
        }
    }

    // [核心新增] 同步维护 PRE_DOUGH/EXTRA 的默认产品 (使其可被生产)
    private async _syncDefaultProduct(tx: Prisma.TransactionClient, versionId: string, name: string, type: RecipeType) {
        if (type === 'MAIN') return;

        // 查找该版本下是否已有产品
        const existingProduct = await tx.product.findFirst({
            where: { recipeVersionId: versionId, deletedAt: null },
        });

        if (existingProduct) {
            if (existingProduct.name !== name) {
                await tx.product.update({
                    where: { id: existingProduct.id },
                    data: { name },
                });
            }
        } else {
            // 创建一个默认产品
            // baseDoughWeight 设为 1，代表单位重量。
            // 在生产任务中，quantity 将代表总重量(g)。
            await tx.product.create({
                data: {
                    recipeVersionId: versionId,
                    name: name,
                    baseDoughWeight: 1,
                    procedure: [],
                },
            });
        }
    }

    private _sortIngredients<
        T extends Prisma.ComponentIngredientGetPayload<{
            include: {
                ingredient: true;
                linkedPreDough: true;
                linkedExtra: true;
            };
        }>,
    >(ingredients: T[], category: RecipeCategory, type: RecipeType): T[] {
        const isFlourSort = type === 'PRE_DOUGH' || category === 'BREAD';

        return ingredients.sort((a, b) => {
            const aIsPreDough = !!a.preDoughId;
            const bIsPreDough = !!b.preDoughId;
            if (aIsPreDough && !bIsPreDough) return -1;
            if (!aIsPreDough && bIsPreDough) return 1;

            if (isFlourSort) {
                const aIsFlour = a.ingredient?.isFlour ?? false;
                const bIsFlour = b.ingredient?.isFlour ?? false;

                if (aIsFlour && !bIsFlour) return -1;
                if (!aIsFlour && bIsFlour) return 1;
            }

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
                        customWaterContent: component.customWaterContent?.toNumber(),
                        ingredients: sortedIngredients.map((componentIngredient) => {
                            let displayIngredient: DisplayIngredient | null = null;

                            if (componentIngredient.ingredient) {
                                // 1. 标准原料
                                const ingWithExtra = componentIngredient.ingredient as IngredientWithExtra;
                                displayIngredient = {
                                    ...ingWithExtra,
                                    waterContent: ingWithExtra.waterContent.toNumber(),
                                    currentStockInGrams: ingWithExtra.currentStockInGrams.toNumber(),
                                    currentStockValue: ingWithExtra.currentStockValue.toNumber(),
                                    // 标准原料无 recipeFamilyId
                                    recipeFamilyId: null,
                                    shelfLife: ingWithExtra.shelfLife,
                                };
                            } else if (componentIngredient.linkedPreDough) {
                                // 2. 面种配方
                                const preDoughWithLink = componentIngredient.linkedPreDough as RecipeFamilyWithLink;
                                displayIngredient = {
                                    ...preDoughWithLink,
                                    extraInfo: preDoughWithLink.extraInfo,
                                    waterContent: 0,
                                    currentStockInGrams: 0,
                                    currentStockValue: 0,
                                    isFlour: false,
                                    activeSkuId: null,
                                    // [核心新增] 获取自制原料的保质期
                                    shelfLife: preDoughWithLink.outputIngredient?.shelfLife ?? 0,
                                    recipeFamilyId: preDoughWithLink.id,
                                };
                            } else if (componentIngredient.linkedExtra) {
                                // 3. 馅料配方
                                const extraWithLink = componentIngredient.linkedExtra as RecipeFamilyWithLink;
                                displayIngredient = {
                                    ...extraWithLink,
                                    extraInfo: extraWithLink.extraInfo,
                                    waterContent: 0,
                                    currentStockInGrams: 0,
                                    currentStockValue: 0,
                                    isFlour: false,
                                    activeSkuId: null,
                                    // [核心新增] 获取自制原料的保质期
                                    shelfLife: extraWithLink.outputIngredient?.shelfLife ?? 0,
                                    recipeFamilyId: extraWithLink.id,
                                };
                            } else {
                                // 4. 兜底
                                displayIngredient = {
                                    id: componentIngredient.id,
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
                                    shelfLife: 0,
                                    recipeFamilyId: null,
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
                            displayProductIngredient = {
                                ...productIngredient.ingredient,
                                waterContent: productIngredient.ingredient.waterContent.toNumber(),
                                currentStockInGrams: productIngredient.ingredient.currentStockInGrams.toNumber(),
                                currentStockValue: productIngredient.ingredient.currentStockValue.toNumber(),
                                shelfLife: productIngredient.ingredient.shelfLife,
                                recipeFamilyId: null,
                            };
                        } else if (productIngredient.linkedExtra) {
                            // EXTRA 配方
                            displayProductIngredient = {
                                ...productIngredient.linkedExtra,
                                waterContent: 0,
                                currentStockInGrams: 0,
                                currentStockValue: 0,
                                isFlour: false,
                                activeSkuId: null,
                                shelfLife: 0, // 暂不 fetch
                                recipeFamilyId: productIngredient.linkedExtra.id,
                            };
                        } else {
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
                                shelfLife: 0,
                                recipeFamilyId: null,
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

    private _calculateWaterContent(family: WaterCalcFamily | null | undefined, depth = 0): number {
        if (!family || depth > 4) return 0;

        const versions = family.versions || [];
        if (versions.length === 0) return 0;
        const activeVersion = versions.find((v) => v.isActive) || versions[0];

        const component = activeVersion.components?.[0];
        if (!component) return 0;

        const rawCustomWater = component.customWaterContent;

        if (rawCustomWater !== null && rawCustomWater !== undefined) {
            let customVal: number;
            if (typeof rawCustomWater === 'object' && 'toNumber' in rawCustomWater) {
                customVal = rawCustomWater.toNumber();
            } else {
                customVal = Number(rawCustomWater);
            }
            return customVal > 5 ? customVal / 100 : customVal;
        }

        if (!component.ingredients) return 0;

        let totalWaterUnits = 0;
        let totalUnits = 0;

        for (const ing of component.ingredients) {
            const ratio = ing.ratio ? (typeof ing.ratio === 'object' ? ing.ratio.toNumber() : Number(ing.ratio)) : 0;

            if (ratio <= 0) continue;

            let waterContent = 0;

            if (ing.ingredient) {
                const rawWaterContent = ing.ingredient?.waterContent;
                waterContent = rawWaterContent
                    ? typeof rawWaterContent === 'object'
                        ? rawWaterContent.toNumber()
                        : Number(rawWaterContent)
                    : 0;
            } else if (ing.linkedPreDough) {
                waterContent = this._calculateWaterContent(ing.linkedPreDough, depth + 1);
            } else if (ing.linkedExtra) {
                waterContent = this._calculateWaterContent(ing.linkedExtra, depth + 1);
            }

            totalWaterUnits += ratio * waterContent;
            totalUnits += ratio;
        }

        if (totalUnits === 0) return 0;
        return totalWaterUnits / totalUnits;
    }

    async batchImportRecipes(
        userId: string,
        recipesDto: BatchImportRecipeDto[],
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
            totalCount: recipesDto.length * targetTenants.length,
            importedCount: 0,
            skippedCount: 0,
            skippedRecipes: [],
        };

        for (const tenant of targetTenants) {
            const tenantId = tenant.id;
            const tenantName = tenant.name;

            for (const recipeDto of recipesDto) {
                try {
                    const existingFamily = await this.prisma.recipeFamily.findFirst({
                        where: {
                            tenantId,
                            name: recipeDto.name,
                            deletedAt: null,
                        },
                        include: {
                            versions: { select: { notes: true } },
                        },
                    });

                    const convertVersionToCreateDto = (versionDto: BatchImportVersionDto): CreateRecipeDto => {
                        return {
                            name: recipeDto.name,
                            type: recipeDto.type,
                            category: recipeDto.category,
                            notes: versionDto.notes,
                            targetTemp: versionDto.targetTemp,
                            lossRatio: versionDto.lossRatio,
                            divisionLoss: versionDto.divisionLoss,
                            procedure: versionDto.procedure,
                            ingredients: versionDto.ingredients.map(
                                (ing: BatchComponentIngredientDto): ComponentIngredientDto => ({
                                    ...ing,
                                    ingredientId: undefined,
                                }),
                            ),
                            products: versionDto.products?.map(
                                (p: BatchProductDto): ProductDto => ({
                                    ...p,
                                    id: undefined,
                                    mixIn:
                                        p.mixIn?.map(
                                            (i): ProductIngredientDto => ({
                                                ...i,
                                                type: ProductIngredientType.MIX_IN,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                    fillings:
                                        p.fillings?.map(
                                            (i): ProductIngredientDto => ({
                                                ...i,
                                                type: ProductIngredientType.FILLING,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                    toppings:
                                        p.toppings?.map(
                                            (i): ProductIngredientDto => ({
                                                ...i,
                                                type: ProductIngredientType.TOPPING,
                                                ingredientId: undefined,
                                            }),
                                        ) || [],
                                }),
                            ),
                        };
                    };

                    if (!existingFamily) {
                        let familyId: string | null = null;
                        let versionsCreatedCount = 0;

                        for (const versionDto of recipeDto.versions) {
                            const createDto = convertVersionToCreateDto(versionDto);

                            if (familyId === null) {
                                const createdFamily = await this.create(tenantId, createDto);

                                if (!createdFamily) {
                                    throw new Error(`创建配方族 "${recipeDto.name}" 失败，_sanitizeFamily 返回 null`);
                                }
                                familyId = createdFamily.id;
                                versionsCreatedCount++;
                            } else {
                                await this.createVersion(tenantId, familyId, createDto);
                                versionsCreatedCount++;
                            }
                        }
                        if (versionsCreatedCount > 0) {
                            overallResult.importedCount++;
                        } else {
                            overallResult.skippedCount++;
                            overallResult.skippedRecipes.push(
                                `${recipeDto.name} (在店铺 "${tenantName}" 导入失败, DTO 中没有版本信息)`,
                            );
                        }
                    } else {
                        const existingVersionNotes = new Set(existingFamily.versions.map((v) => v.notes));
                        let newVersionsAdded = 0;

                        for (const versionDto of recipeDto.versions) {
                            if (existingVersionNotes.has(versionDto.notes)) {
                                continue;
                            }

                            const createDto = convertVersionToCreateDto(versionDto);
                            await this.createVersion(tenantId, existingFamily.id, createDto);
                            newVersionsAdded++;
                        }

                        if (newVersionsAdded > 0) {
                            overallResult.importedCount++;
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

        const families = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId: tenantId,
                deletedAt: null,
            },
            include: recipeFamilyForExportInclude,
        });

        const exportableFamilies: BatchImportRecipeDto[] = families.map((family) => {
            const exportableVersions = family.versions.map((version) => this._exportVersion(version, family.type));

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
        const toNum = (val: Prisma.Decimal | null | undefined): number | undefined => {
            if (val === null || val === undefined) return undefined;
            return val.toNumber();
        };

        const formatComponentIngredient = (ing: ComponentIngredientForExport): BatchComponentIngredientDto | null => {
            if (ing.linkedPreDough) {
                return {
                    name: ing.linkedPreDough.name,
                    flourRatio: toNum(ing.flourRatio),
                };
            }
            if (ing.linkedExtra) {
                return {
                    name: ing.linkedExtra.name,
                    ratio: toNum(ing.ratio),
                };
            }
            if (ing.ingredient) {
                const result: BatchComponentIngredientDto = {
                    name: ing.ingredient.name,
                    ratio: toNum(ing.ratio),
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
            const mainComponent = version.components[0];
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
                                name: i.ingredient?.name || i.linkedExtra!.name,
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
                products: [],
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
                    where: { deletedAt: null },
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
                customWaterContent,
                procedure,
                name,
                type = 'MAIN',
                category,
                shelfLife = 0, // [核心新增] 接收 shelfLife 参数，默认0
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

            const linkedFamilies = await this.preloadLinkedFamilies(tenantId, ingredients, tx);

            await this._validateCircularReference(familyId, updateRecipeDto.name, ingredients, linkedFamilies, tx);

            this.calculateAndValidateLinkedFamilyRatios(type, ingredients, linkedFamilies);

            this._validateBakerPercentage(type, category, ingredients);

            const component = await tx.recipeComponent.create({
                data: {
                    recipeVersionId: versionId,
                    name: name,
                    targetTemp: type === 'MAIN' ? targetTemp : undefined,
                    lossRatio: lossRatio,
                    divisionLoss: divisionLoss,
                    customWaterContent: customWaterContent,
                    procedure: procedure,
                },
            });

            for (const ingredientDto of ingredients) {
                const linkedFamily = linkedFamilies.get(ingredientDto.name);

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
                        preDoughId: preDoughId,
                        extraId: extraId,
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

            // [核心新增] 同步更新自制原料的含水量、名称和保质期
            const waterContent = this._calculateWaterContent(updatedFamily as unknown as WaterCalcFamily);
            await this._syncSelfMadeIngredient(tx, tenantId, familyId, name, type, waterContent, shelfLife);

            // [核心新增] 同步更新默认产品
            await this._syncDefaultProduct(tx, versionId, name, type);

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

        const productsToSoftDelete = existingProducts.filter((p) => !newProductIds.has(p.id));

        if (productsToSoftDelete.length > 0) {
            const productIdsToSoftDelete = productsToSoftDelete.map((p) => p.id);

            const usageCount = await tx.productionTaskItem.count({
                where: {
                    productId: { in: productIdsToSoftDelete },
                    task: {
                        status: { in: ['PENDING', 'IN_PROGRESS'] },
                    },
                },
            });

            if (usageCount > 0) {
                const productNames = productsToSoftDelete.map((p) => p.name).join(', ');
                throw new BadRequestException(
                    `无法删除产品: ${productNames}，因为它已被一个“待开始”或“进行中”的生产任务使用。`,
                );
            }

            await tx.product.updateMany({
                where: { id: { in: productIdsToSoftDelete } },
                data: { deletedAt: new Date() },
            });
        }

        for (const productDto of newProductsDto) {
            const existingProduct = productDto.id ? existingProductsMap.get(productDto.id) : undefined;

            if (existingProduct) {
                await tx.product.update({
                    where: { id: existingProduct.id },
                    data: {
                        name: productDto.name,
                        baseDoughWeight: new Prisma.Decimal(productDto.weight),
                        procedure: productDto.procedure,
                        deletedAt: null,
                    },
                });
                await tx.productIngredient.deleteMany({ where: { productId: existingProduct.id } });
                await this._createProductIngredients(tenantId, existingProduct.id, productDto, tx);
            } else {
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
        const { name, type = 'MAIN', category, shelfLife = 0 } = createRecipeDto;

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
                    recipeFamily = existingFamily as RecipeFamilyWithVersions;
                } else {
                    const existingIngredient = await tx.ingredient.findFirst({
                        where: {
                            tenantId,
                            name: name,
                            deletedAt: null,
                        },
                        select: { id: true },
                    });

                    recipeFamily = await tx.recipeFamily.create({
                        data: { name, tenantId, type, category: finalCategory },
                        include: { versions: true },
                    });

                    if (existingIngredient) {
                        const newFamilyId = recipeFamily.id;
                        const oldIngredientId = existingIngredient.id;

                        if (type === 'PRE_DOUGH') {
                            await tx.componentIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    preDoughId: newFamilyId,
                                },
                            });
                        } else if (type === 'EXTRA') {
                            await tx.componentIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    extraId: newFamilyId,
                                },
                            });
                        }

                        if (type === 'EXTRA') {
                            await tx.productIngredient.updateMany({
                                where: { ingredientId: oldIngredientId },
                                data: {
                                    ingredientId: null,
                                    linkedExtraId: newFamilyId,
                                },
                            });
                        }

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

                const waterContent = this._calculateWaterContent(finalFamily as unknown as WaterCalcFamily);
                // [核心新增] 同步自制原料 (传入 shelfLife)
                await this._syncSelfMadeIngredient(tx, tenantId, recipeFamily.id, name, type, waterContent, shelfLife);

                await this._syncDefaultProduct(tx, recipeVersion.id, name, type);

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
            customWaterContent,
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

        const linkedFamilies = await this.preloadLinkedFamilies(tenantId, ingredients, tx);

        const parentVersion = await tx.recipeVersion.findUnique({
            where: { id: versionId },
            include: { family: { select: { id: true, name: true } } },
        });
        if (!parentVersion) {
            throw new NotFoundException('无法找到配方版本');
        }
        const parentFamilyId = parentVersion.family.id;
        const parentRecipeName = parentVersion.family.name;

        await this._validateCircularReference(parentFamilyId, parentRecipeName, ingredients, linkedFamilies, tx);

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
        const customWaterContentForDb =
            customWaterContent === null || customWaterContent === undefined
                ? undefined
                : new Prisma.Decimal(customWaterContent);

        const component = await tx.recipeComponent.create({
            data: {
                recipeVersionId: versionId,
                name: name,
                targetTemp: type === 'MAIN' ? targetTempForDb : undefined,
                lossRatio: lossRatioForDb,
                divisionLoss: divisionLossForDb,
                customWaterContent: customWaterContentForDb,
                procedure: procedure,
            },
        });

        for (const ingredientDto of ingredients) {
            const linkedFamily = linkedFamilies.get(ingredientDto.name);

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
                    preDoughId: preDoughId,
                    extraId: extraId,
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

        const existingIngredients = await tx.ingredient.findMany({
            where: {
                tenantId,
                name: { in: allIngredientNames },
                deletedAt: null,
            },
        });
        const existingIngredientMap = new Map(existingIngredients.map((i) => [i.name, i]));

        const existingFamilies = await tx.recipeFamily.findMany({
            where: {
                tenantId,
                name: { in: allIngredientNames },
                deletedAt: null,
            },
        });
        const existingFamilyNames = new Set(existingFamilies.map((f) => f.name));
        const ingredientsToCreate: Prisma.IngredientCreateManyInput[] = [];

        const isWaterName = (n: string) => ['水', 'water', '冰水', '温水', '纯净水'].includes(n.toLowerCase());

        for (const name of allIngredientNames) {
            if (!existingIngredientMap.has(name) && !existingFamilyNames.has(name)) {
                const dto = allRawIngredients.find((ing) => ing.name === name);
                if (!dto) continue;

                let waterContentForDb = 0;
                let isFlourForDb = false;

                if ('waterContent' in dto && dto.waterContent !== undefined) {
                    waterContentForDb = dto.waterContent;
                } else if (isWaterName(name)) {
                    waterContentForDb = 1;
                }

                if ('isFlour' in dto && dto.isFlour !== undefined) {
                    isFlourForDb = dto.isFlour;
                }

                const typeForDb =
                    waterContentForDb === 1 && !isFlourForDb ? IngredientType.UNTRACKED : IngredientType.STANDARD;

                const newIngredientData: Prisma.IngredientCreateManyInput = {
                    tenantId,
                    name: name,
                    type: typeForDb,
                    isFlour: isFlourForDb,
                    waterContent: new Prisma.Decimal(waterContentForDb),
                };
                ingredientsToCreate.push(newIngredientData);
            }
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
                    deletedAt: null,
                },
            });
            for (const created of createdIngredients) {
                existingIngredientMap.set(created.name, created);
            }
        }

        for (const ing of allRawIngredients) {
            if (existingFamilyNames.has(ing.name)) {
                ing.ingredientId = undefined;
            } else {
                const existing = existingIngredientMap.get(ing.name);
                if (existing && 'id' in existing) {
                    ing.ingredientId = existing.id;
                } else {
                    ing.ingredientId = undefined;
                }
            }
        }
    }

    async findAll(tenantId: string) {
        // 1. 数据库查询：必须查出 ingredients 及其嵌套关系，否则无法计算
        // 注意：为了支持递归，这里嵌套了多层 include
        const queryInclude = {
            versions: {
                where: { isActive: true },
                take: 1, // 只查最新激活版本，优化性能
                include: {
                    products: { where: { deletedAt: null } },
                    components: {
                        include: {
                            ingredients: {
                                include: {
                                    ingredient: true, // 查标准原料
                                    // 查引用的面种 (嵌套一层以便计算)
                                    linkedPreDough: {
                                        include: {
                                            versions: {
                                                where: { isActive: true },
                                                take: 1,
                                                include: {
                                                    components: {
                                                        include: { ingredients: { include: { ingredient: true } } },
                                                    },
                                                },
                                            },
                                        },
                                    },
                                    // 查引用的馅料 (嵌套一层以便计算)
                                    linkedExtra: {
                                        include: {
                                            versions: {
                                                where: { isActive: true },
                                                take: 1,
                                                include: {
                                                    components: {
                                                        include: { ingredients: { include: { ingredient: true } } },
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
            _count: {
                select: {
                    usedInComponentsAsPreDough: true,
                    usedInComponentsAsExtra: true,
                    usedInProducts: true,
                },
            },
        };

        const rawFamilies = await this.prisma.recipeFamily.findMany({
            where: { tenantId, deletedAt: null },
            include: queryInclude,
        });

        const familiesWithCounts = await Promise.all(
            rawFamilies.map(async (family) => {
                // [修改] 计算逻辑移植自原代码
                const activeVersion = family.versions.find((v) => v.isActive) || family.versions[0];
                const productCount = activeVersion?.products?.length || 0;
                const ingredientCount =
                    activeVersion?.components.reduce(
                        (sum, component) => sum + (component.ingredients?.length || 0),
                        0,
                    ) || 0;

                const usageCount =
                    (family._count?.usedInComponentsAsPreDough || 0) +
                    (family._count?.usedInComponentsAsExtra || 0) +
                    (family._count?.usedInProducts || 0);

                if (family.type !== 'MAIN') {
                    return { ...family, ingredientCount, usageCount, productionTaskCount: 0, productCount };
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

        // 2. 数据转换与“瘦身”
        // 在这里计算含水量，并丢弃不需要返回给前端的 heavy data
        const sanitizedFamilies = familiesWithCounts.map((family) => {
            // A. 计算含水量
            const calculatedWater = this._calculateWaterContent(family as unknown as WaterCalcFamily);

            return {
                id: family.id,
                name: family.name,
                type: family.type,
                category: family.category,
                updatedAt: family.updatedAt,
                waterContent: calculatedWater, // 返回计算后的含水量
                // versions: family.versions, // 不返回 versions 以减少数据量
                productCount: family.productCount,
                ingredientCount: family.ingredientCount,
                productionTaskCount: family.productionTaskCount,
                usageCount: family.usageCount,
            };
        });

        return {
            mainRecipes: sanitizedFamilies
                .filter((f) => f.type === 'MAIN')
                .sort((a, b) => (b.productionTaskCount || 0) - (a.productionTaskCount || 0)),
            preDoughs: sanitizedFamilies
                .filter((f) => f.type === 'PRE_DOUGH')
                .sort((a, b) => a.name.localeCompare(b.name)),
            extras: sanitizedFamilies.filter((f) => f.type === 'EXTRA').sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    // [核心修改] 实现 findProductsForTasks 的新逻辑
    // 修复了 any 类型错误，并增加了自制原料和默认产品的惰性补全
    async findProductsForTasks(tenantId: string) {
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                deletedAt: null,
                versions: {
                    some: {
                        isActive: true,
                    },
                },
            },
            include: {
                versions: {
                    where: { isActive: true },
                    include: {
                        products: {
                            where: { deletedAt: null },
                            orderBy: { name: 'asc' },
                        },
                        components: {
                            include: {
                                ingredients: {
                                    include: { ingredient: true, linkedPreDough: true, linkedExtra: true },
                                },
                            },
                        },
                    },
                },
                outputIngredient: true,
            },
        });

        // 使用推断类型来替代 any
        type RecipeFamilyWithIncludes = (typeof recipeFamilies)[number];
        const familiesWithCount: {
            family: RecipeFamilyWithIncludes;
            taskCount: number;
            products: RecipeFamilyWithIncludes['versions'][number]['products'];
        }[] = [];

        const groupedByCategory: Record<string, Record<string, { id: string; name: string }[]>> = {};

        for (const family of recipeFamilies) {
            const activeVersion = family.versions[0];
            if (!activeVersion) continue;

            if (family.type === 'MAIN') {
                if (activeVersion.products.length === 0) continue;

                const productIds = activeVersion.products.map((p) => p.id);
                const taskCount = await this.prisma.productionTaskItem.count({
                    where: {
                        productId: { in: productIds },
                        task: { status: 'COMPLETED', deletedAt: null },
                    },
                });

                familiesWithCount.push({
                    family,
                    taskCount,
                    products: activeVersion.products,
                });
            } else {
                // [核心逻辑] 处理非主配方 (自制原料)
                const targetCategory = 'OTHER';
                let productId = activeVersion.products[0]?.id;

                if (!productId) {
                    const newProduct = await this.prisma.product.create({
                        data: {
                            recipeVersionId: activeVersion.id,
                            name: family.name,
                            baseDoughWeight: 1,
                            procedure: [],
                        },
                    });
                    productId = newProduct.id;
                }

                if (!family.outputIngredient) {
                    const waterContent = this._calculateWaterContent(family as unknown as WaterCalcFamily);
                    try {
                        await this.prisma.ingredient.create({
                            data: {
                                tenantId,
                                name: family.name,
                                type: IngredientType.SELF_MADE,
                                recipeFamilyId: family.id,
                                isFlour: false,
                                waterContent: new Prisma.Decimal(waterContent),
                                shelfLife: 0,
                            },
                        });
                    } catch (e) {
                        console.warn('Auto-create ingredient failed (likely exists):', e);
                    }
                }

                if (!groupedByCategory[targetCategory]) {
                    groupedByCategory[targetCategory] = {};
                }
                if (!groupedByCategory[targetCategory][family.name]) {
                    groupedByCategory[targetCategory][family.name] = [];
                }

                const productObj = activeVersion.products[0] || { id: productId, name: family.name };

                groupedByCategory[targetCategory][family.name].push({
                    id: productObj.id,
                    name: productObj.name,
                });
            }
        }

        familiesWithCount.sort((a, b) => b.taskCount - a.taskCount);

        for (const item of familiesWithCount) {
            const { family, products } = item;
            const category = family.category;

            if (!groupedByCategory[category]) groupedByCategory[category] = {};
            if (!groupedByCategory[category][family.name]) groupedByCategory[category][family.name] = [];

            products.forEach((p) => {
                groupedByCategory[category][family.name].push({
                    id: p.id,
                    name: p.name,
                });
            });
        }

        return groupedByCategory;
    }

    async findOne(familyId: string) {
        const family = await this.prisma.recipeFamily.findFirst({
            where: {
                id: familyId,
                deletedAt: null,
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
                                    const extraInfo = ingredientNotes.get(ing.linkedPreDough.name);
                                    (ing.linkedPreDough as RecipeFamilyWithLink).extraInfo = extraInfo || undefined;
                                }
                                if (ing.linkedExtra) {
                                    const extraInfo = ingredientNotes.get(ing.linkedExtra.name);
                                    (ing.linkedExtra as RecipeFamilyWithLink).extraInfo = extraInfo || undefined;
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
                    deletedAt: null,
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
                                linkedExtra: true,
                            },
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
                customWaterContent: componentSource.customWaterContent?.toNumber(),
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

            const sortedIngredients = this._sortIngredients(
                mainComponentSource.ingredients,
                version.family.category,
                version.family.type,
            );

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
                } else if (ing.ingredient) {
                    mainComponentIngredientsForForm.push({
                        id: ing.ingredient.id,
                        name: ing.ingredient.name,
                        ratio: toCleanPercent(ing.ratio),
                        isRecipe: false,
                        isFlour: ing.ingredient.isFlour,
                        waterContent: ing.ingredient.waterContent.toNumber(),
                    });
                } else if (ing.linkedExtra) {
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
                    return p.ingredients
                        .filter((ing) => ing.type === type && (ing.ingredient || ing.linkedExtra))
                        .sort((a, b) => {
                            const aWeight = a.weightInGrams ? new Prisma.Decimal(a.weightInGrams).toNumber() : 0;
                            const bWeight = b.weightInGrams ? new Prisma.Decimal(b.weightInGrams).toNumber() : 0;
                            if (aWeight !== 0 || bWeight !== 0) {
                                return bWeight - aWeight;
                            }
                            const aRatio = a.ratio ? new Prisma.Decimal(a.ratio).toNumber() : 0;
                            const bRatio = b.ratio ? new Prisma.Decimal(b.ratio).toNumber() : 0;
                            return bRatio - aRatio;
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
                        });
                };
                return {
                    id: p.id,
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
        const linkedRecipeNames = ingredients.map((ing) => ing.name);

        if (linkedRecipeNames.length === 0) {
            return new Map();
        }

        const families = await tx.recipeFamily.findMany({
            where: {
                name: { in: linkedRecipeNames },
                tenantId,
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

    private async _getDescendantFamilyIds(
        familyId: string,
        tx: Prisma.TransactionClient,
        visited: Set<string>,
    ): Promise<Set<string>> {
        if (visited.has(familyId)) {
            return new Set<string>();
        }
        visited.add(familyId);

        const activeVersion = await tx.recipeVersion.findFirst({
            where: { familyId: familyId, isActive: true },
            include: {
                components: {
                    include: {
                        ingredients: {
                            select: { preDoughId: true, extraId: true },
                        },
                    },
                },
            },
        });

        if (!activeVersion?.components[0]) {
            return new Set<string>();
        }

        const childRecipeIds = new Set<string>();
        for (const ing of activeVersion.components[0].ingredients) {
            if (ing.preDoughId) childRecipeIds.add(ing.preDoughId);
            if (ing.extraId) childRecipeIds.add(ing.extraId);
        }

        const allDescendants = new Set<string>(childRecipeIds);
        for (const childId of childRecipeIds) {
            const grandChildren = await this._getDescendantFamilyIds(childId, tx, visited);
            grandChildren.forEach((gcId) => allDescendants.add(gcId));
        }

        return allDescendants;
    }

    private async _validateCircularReference(
        parentFamilyId: string,
        parentRecipeName: string,
        ingredients: ComponentIngredientDto[],
        linkedFamilies: Map<string, PreloadedRecipeFamily>,
        tx: Prisma.TransactionClient,
    ) {
        for (const ingredientDto of ingredients) {
            const linkedFamily = linkedFamilies.get(ingredientDto.name);
            if (!linkedFamily) continue;

            if (linkedFamily.id === parentFamilyId) {
                throw new BadRequestException(`配方 "${parentRecipeName}" 不能引用自己作为原料。`);
            }

            const descendants = await this._getDescendantFamilyIds(linkedFamily.id, tx, new Set<string>());

            if (descendants.has(parentFamilyId)) {
                throw new BadRequestException(
                    `循环引用：配方 "${linkedFamily.name}" 已经（或间接）引用了您正在保存的配方 "${parentRecipeName}"。`,
                );
            }
        }
    }

    private calculateAndValidateLinkedFamilyRatios(
        parentType: RecipeType,
        ingredients: ComponentIngredientDto[],
        linkedFamilies: Map<string, PreloadedRecipeFamily>,
    ) {
        for (const ing of ingredients) {
            const linkedFamily = linkedFamilies.get(ing.name);
            if (!linkedFamily) {
                if (ing.flourRatio !== undefined && ing.flourRatio !== null) {
                    throw new BadRequestException(`原料 "${ing.name}" 是一个标准原料，不能使用面粉比例(flourRatio)。`);
                }
                continue;
            }

            if (linkedFamily.type === 'PRE_DOUGH') {
                if (parentType === 'EXTRA') {
                    throw new BadRequestException(
                        `逻辑错误：配方 "${ing.name}" 是面种(PRE_DOUGH)，但当前配方是附加项(EXTRA)。附加项配方不能引用面种。`,
                    );
                }

                if (ing.flourRatio === undefined || ing.flourRatio === null) {
                    throw new BadRequestException(
                        `配方 "${ing.name}" 是面种(PRE_DOUGH)，必须使用面粉比例(flourRatio)来引用。`,
                    );
                }
                if (ing.ratio !== undefined && ing.ratio !== null) {
                    throw new BadRequestException(`配方 "${ing.name}" 是面种(PRE_DOUGH)，不能使用常规比例(ratio)。`);
                }

                const preDoughRecipe = linkedFamily?.versions[0]?.components[0];
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
            } else {
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
