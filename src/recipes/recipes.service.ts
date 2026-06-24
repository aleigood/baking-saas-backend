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
    RecipeCategory,
    Ingredient,
    TenantRole,
} from '@prisma/client';
import { RecipeFormTemplateDto, ComponentTemplate } from './dto/recipe-form-template.dto';
import {
    BatchImportRecipeDto,
    BatchImportResultDto,
    BatchImportVersionDto,
    BatchComponentIngredientDto,
    BatchProductDto,
} from './dto/batch-import-recipe.dto';
import {
    ApplyDependencyUpgradeResultDto,
    DependencyUpgradeItemDto,
    DependencyUpgradePlanDto,
    PendingDependencyUpgradePlanDto,
} from './dto/dependency-upgrade.dto';
import { EntitlementsService } from '../billing/entitlements.service';

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
    activeSkuId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    extraInfo?: string;
    // [核心新增]
    recipeFamilyId?: string | null;
}

type IngredientWithExtra = Ingredient & { extraInfo?: string };
// RecipeFamily 包含 outputIngredient
type RecipeFamilyWithLink = RecipeFamily & { outputIngredient?: Ingredient | null; extraInfo?: string };

const recipeFamilyWithDetailsInclude = {
    versions: {
        include: {
            createdBy: { select: { id: true, name: true, phone: true } },
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

type RecipeVersionChangeItem = {
    kind:
        | 'INITIAL_VERSION'
        | 'NO_CHANGES'
        | 'LEGACY_TEXT'
        | 'INGREDIENT_ADDED'
        | 'INGREDIENT_REMOVED'
        | 'INGREDIENT_RATIO_CHANGED'
        | 'DEPENDENCY_VERSION_CHANGED'
        | 'PRODUCT_ADDED'
        | 'PRODUCT_REMOVED'
        | 'PRODUCT_WEIGHT_CHANGED'
        | 'PRODUCT_INGREDIENT_ADDED'
        | 'PRODUCT_INGREDIENT_REMOVED'
        | 'PRODUCT_INGREDIENT_AMOUNT_CHANGED'
        | 'PROCEDURE_CHANGED'
        | 'FIELD_CHANGED';
    name?: string;
    productName?: string;
    ingredientType?: 'MIX_IN' | 'FILLING' | 'TOPPING';
    basis?: 'FLOUR_SHARE' | 'RECIPE_RATIO';
    field?: string;
    scope?: 'RECIPE' | 'PRODUCT';
    before?: number;
    after?: number;
    beforeVersion?: number;
    afterVersion?: number;
    unit?: 'RATIO' | 'GRAM' | 'CELSIUS' | 'PERCENT';
    text?: string;
};

type RecipeVersionChangeSummary = {
    schemaVersion: 1;
    items: RecipeVersionChangeItem[];
};

type RecipeOperationAction =
    | 'RECIPE_CREATED'
    | 'RECIPE_DISCONTINUED'
    | 'RECIPE_RESTORED'
    | 'VERSION_CREATED'
    | 'VERSION_UPDATED'
    | 'VERSION_NOTES_UPDATED'
    | 'VERSION_ACTIVATED'
    | 'DEPENDENCY_UPDATED';

@Injectable()
export class RecipesService {
    constructor(
        private prisma: PrismaService,
        private readonly entitlements: EntitlementsService,
    ) {}

    private async _recordOperation(
        tx: Prisma.TransactionClient,
        input: {
            tenantId: string;
            familyId: string;
            versionId?: string;
            actorUserId?: string;
            action: RecipeOperationAction;
            description: string;
            metadata?: Prisma.InputJsonValue;
        },
    ) {
        await tx.recipeOperationLog.create({
            data: {
                tenantId: input.tenantId,
                familyId: input.familyId,
                versionId: input.versionId,
                actorUserId: input.actorUserId,
                action: input.action,
                description: input.description,
                metadata: input.metadata,
            },
        });
    }

    // [核心新增] 同步维护 SELF_MADE 原料
    private async _syncSelfMadeIngredient(
        tx: Prisma.TransactionClient,
        tenantId: string,
        familyId: string,
        name: string,
        type: RecipeType,
        waterContent: number,
    ) {
        // 主配方不产生原料
        if (type === 'MAIN') return;

        // 查找是否已存在关联的原料
        const existing = await tx.ingredient.findUnique({
            where: { recipeFamilyId: familyId },
        });

        if (existing) {
            // 如果名称或含水量有变化，则更新
            if (existing.name !== name || existing.waterContent.toNumber() !== waterContent) {
                await tx.ingredient.update({
                    where: { id: existing.id },
                    data: {
                        name,
                        waterContent: new Prisma.Decimal(waterContent),
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
                                    recipeFamilyId: null,
                                };
                            } else if (componentIngredient.linkedPreDough) {
                                // 2. 面种配方
                                const preDoughWithLink = componentIngredient.linkedPreDough as RecipeFamilyWithLink;
                                displayIngredient = {
                                    ...preDoughWithLink,
                                    extraInfo: preDoughWithLink.extraInfo,
                                    // [核心修复] 获取 outputIngredient 的含水量，如果不存在则默认为0
                                    waterContent: preDoughWithLink.outputIngredient?.waterContent.toNumber() ?? 0,
                                    isFlour: false,
                                    activeSkuId: null,
                                    recipeFamilyId: preDoughWithLink.id,
                                };
                            } else if (componentIngredient.linkedExtra) {
                                // 3. 馅料配方
                                const extraWithLink = componentIngredient.linkedExtra as RecipeFamilyWithLink;
                                displayIngredient = {
                                    ...extraWithLink,
                                    extraInfo: extraWithLink.extraInfo,
                                    // [核心修复] 获取 outputIngredient 的含水量
                                    waterContent: extraWithLink.outputIngredient?.waterContent.toNumber() ?? 0,
                                    isFlour: false,
                                    activeSkuId: null,
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
                                    createdAt: new Date(),
                                    updatedAt: new Date(),
                                    deletedAt: null,
                                    tenantId: family.tenantId,
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
                                recipeFamilyId: null,
                            };
                        } else if (productIngredient.linkedExtra) {
                            // EXTRA 配方
                            displayProductIngredient = {
                                ...productIngredient.linkedExtra,
                                waterContent: 0,
                                isFlour: false,
                                activeSkuId: null,
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
                                createdAt: new Date(),
                                updatedAt: new Date(),
                                deletedAt: null,
                                tenantId: family.tenantId,
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
        actorUserId = userId,
    ): Promise<BatchImportResultDto> {
        let targetTenants: { id: string; name: string }[];

        if (tenantIds && tenantIds.length > 0) {
            const ownedTenants = await this.prisma.tenant.findMany({
                where: {
                    id: { in: tenantIds },
                    members: {
                        some: {
                            userId,
                            role: TenantRole.OWNER,
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
                            role: TenantRole.OWNER,
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
                                const createdFamily = await this.create(tenantId, actorUserId, createDto);

                                if (!createdFamily) {
                                    throw new Error(`创建配方族 "${recipeDto.name}" 失败，_sanitizeFamily 返回 null`);
                                }
                                familyId = createdFamily.id;
                                versionsCreatedCount++;
                            } else {
                                await this.createVersion(tenantId, familyId, actorUserId, createDto);
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
                            await this.createVersion(tenantId, existingFamily.id, actorUserId, createDto);
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
                role: TenantRole.OWNER,
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
            // 【修改】：给 _exportVersion 增加 family.category 参数
            const exportableVersions = family.versions.map((version) =>
                this._exportVersion(version, family.type, family.category),
            );

            return {
                name: family.name,
                type: family.type,
                category: family.category,
                versions: exportableVersions,
            };
        });

        // 核心同步逻辑：1. 按配方类型排序(面种->自制->产品) 2. 同类型下按中文名称拼音排序
        const order: Record<string, number> = { PRE_DOUGH: 1, EXTRA: 2, MAIN: 3 };
        exportableFamilies.sort((a, b) => {
            const typeDiff = order[a.type] - order[b.type];
            if (typeDiff !== 0) return typeDiff;
            return a.name.localeCompare(b.name, 'zh-CN');
        });

        return exportableFamilies;
    }

    // 【修改】：增加 category 参数
    private _exportVersion(
        version: RecipeVersionForExport,
        familyType: RecipeType,
        category: string | null | undefined,
    ): BatchImportVersionDto {
        const toNum = (val: Prisma.Decimal | null | undefined): number | undefined => {
            if (val === null || val === undefined) return undefined;
            return val.toNumber();
        };

        // 【新增】：核心判断规则，面种和面包才把面粉置顶
        const isFlourSort = familyType === 'PRE_DOUGH' || category === 'BREAD';

        // 过滤空步骤
        const filterProcedure = (proc: string[]) => proc.filter((p) => p.trim() !== '');

        // 明确返回 BatchComponentIngredientDto 类型，移除 any
        const formatIng = (
            ingName: string,
            ratio?: number,
            isFlour?: boolean,
            waterContent?: number,
        ): BatchComponentIngredientDto => {
            const r: BatchComponentIngredientDto = { name: ingName };
            if (ratio !== undefined && ratio !== null) r.ratio = ratio;
            if (isFlour) r.isFlour = true;
            if (waterContent && waterContent > 0) r.waterContent = waterContent;
            return r;
        };

        // 明确返回 BatchComponentIngredientDto | null，移除 any
        const formatComponentIngredient = (ing: ComponentIngredientForExport): BatchComponentIngredientDto | null => {
            if (ing.linkedPreDough) {
                return {
                    name: ing.linkedPreDough.name,
                    flourRatio: toNum(ing.flourRatio),
                };
            }
            if (ing.linkedExtra) {
                return formatIng(ing.linkedExtra.name, toNum(ing.ratio));
            }
            if (ing.ingredient) {
                return formatIng(
                    ing.ingredient.name,
                    toNum(ing.ratio),
                    ing.ingredient.isFlour,
                    ing.ingredient.waterContent.toNumber(),
                );
            }
            return null;
        };

        if (familyType === 'MAIN') {
            const mainComponent = version.components[0];
            if (!mainComponent) {
                return { notes: version.notes || '', ingredients: [], products: [] };
            }

            // 使用类型守卫确保数组内部没有 null，从而消除展开及赋值时的 unsafe 警告
            const preDoughs = mainComponent.ingredients
                .filter((i) => !!i.linkedPreDough)
                .map(formatComponentIngredient)
                .filter((ing): ing is BatchComponentIngredientDto => ing !== null);

            const others = mainComponent.ingredients
                .filter((i) => !i.linkedPreDough && (i.ingredient || i.linkedExtra) && i.ratio !== null)
                .map(formatComponentIngredient)
                .filter((ing): ing is BatchComponentIngredientDto => ing !== null)
                // 【修改】：带业务逻辑的智能排序
                .sort((a, b) => {
                    if (isFlourSort) {
                        if (a.isFlour && !b.isFlour) return -1;
                        if (!a.isFlour && b.isFlour) return 1;
                    }
                    return (b.ratio ?? 0) - (a.ratio ?? 0);
                });

            const finalIngredients: BatchComponentIngredientDto[] = [...preDoughs, ...others];

            return {
                notes: version.notes || '',
                // [新增] 判断如果有值则输出，否则默认输出 26
                targetTemp:
                    mainComponent.targetTemp !== null && mainComponent.targetTemp !== undefined
                        ? toNum(mainComponent.targetTemp)
                        : 26,
                lossRatio: toNum(mainComponent.lossRatio),
                divisionLoss: toNum(mainComponent.divisionLoss),
                procedure: filterProcedure(mainComponent.procedure),
                ingredients: finalIngredients,
                products: version.products.map((p) => {
                    return {
                        name: p.name,
                        weight: p.baseDoughWeight.toNumber(),
                        procedure: filterProcedure(p.procedure),
                        mixIn: p.ingredients
                            .filter((i) => i.type === 'MIX_IN' && (i.ingredient || i.linkedExtra))
                            .map((i) => {
                                if (i.linkedExtra) return formatIng(i.linkedExtra.name, toNum(i.ratio));
                                return formatIng(
                                    i.ingredient!.name,
                                    toNum(i.ratio),
                                    i.ingredient!.isFlour,
                                    i.ingredient!.waterContent.toNumber(),
                                );
                            }),
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
                // 移除 products 字段
                return { notes: version.notes || '', ingredients: [] } as unknown as BatchImportVersionDto;
            }

            return {
                notes: version.notes || '',
                lossRatio: toNum(component.lossRatio),
                customWaterContent:
                    component.customWaterContent !== null ? toNum(component.customWaterContent) : undefined,
                ingredients: component.ingredients
                    .filter((i) => i.ratio !== null)
                    .map(formatComponentIngredient)
                    .filter((ing): ing is BatchComponentIngredientDto => ing !== null)
                    // 【修改】：非主面团（面种或辅料）同样应用这套智能排序
                    .sort((a, b) => {
                        if (isFlourSort) {
                            if (a.isFlour && !b.isFlour) return -1;
                            if (!a.isFlour && b.isFlour) return 1;
                        }
                        return (b.ratio ?? 0) - (a.ratio ?? 0);
                    }),
                procedure: filterProcedure(component.procedure),
                // 彻底移除 products 字段，直接用 unknown 强转骗过 TS 的类型检查，生成完全干净的 JSON 节点
            } as unknown as BatchImportVersionDto;
        }
    }

    async create(tenantId: string, actorUserId: string, createRecipeDto: CreateRecipeDto) {
        const { name } = createRecipeDto;

        await this.entitlements.assertCanCreateRecipe(tenantId, createRecipeDto.type ?? RecipeType.MAIN);

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

        return this.createVersionInternal(
            tenantId,
            null,
            actorUserId,
            createRecipeDto,
            false,
            undefined,
            'RECIPE_CREATED',
        );
    }

    async createVersion(tenantId: string, familyId: string, actorUserId: string, createRecipeDto: CreateRecipeDto) {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const recipeFamily = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId, deletedAt: null },
            include: {
                versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true } },
            },
        });

        if (!recipeFamily) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        const latestVersionId = recipeFamily.versions[0]?.id;
        const changeSummary = latestVersionId
            ? await this._buildVersionChangeSummary(tenantId, familyId, latestVersionId, createRecipeDto)
            : { schemaVersion: 1 as const, items: [{ kind: 'INITIAL_VERSION' as const }] };
        return this.createVersionInternal(
            tenantId,
            familyId,
            actorUserId,
            createRecipeDto,
            false,
            changeSummary,
            'VERSION_CREATED',
        );
    }

    async updateVersion(
        tenantId: string,
        familyId: string,
        versionId: string,
        actorUserId: string,
        updateRecipeDto: CreateRecipeDto,
    ) {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const latestVersion = await this.prisma.recipeVersion.findFirst({
            where: {
                familyId,
                family: { tenantId, deletedAt: null },
            },
            orderBy: { version: 'desc' },
            select: { id: true },
        });

        if (!latestVersion) {
            throw new NotFoundException('指定的配方版本不存在');
        }
        if (latestVersion.id !== versionId) {
            throw new BadRequestException('只能基于最新版本新建配方版本，请刷新后重试。');
        }

        const changeSummary = await this._buildVersionChangeSummary(tenantId, familyId, versionId, updateRecipeDto);
        return this.createVersionInternal(
            tenantId,
            familyId,
            actorUserId,
            updateRecipeDto,
            false,
            changeSummary,
            'VERSION_UPDATED',
        );
    }

    async updateVersionNotes(
        tenantId: string,
        familyId: string,
        versionId: string,
        actorUserId: string,
        notes: string,
    ) {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const version = await this.prisma.recipeVersion.findFirst({
            where: { id: versionId, familyId, family: { tenantId } },
            select: { id: true, version: true, notes: true },
        });
        if (!version) throw new NotFoundException('指定的配方版本不存在');

        const nextNotes = notes.trim();
        if (version.notes === nextNotes) return version;

        return this.prisma.$transaction(async (tx) => {
            const updated = await tx.recipeVersion.update({
                where: { id: versionId },
                data: { notes: nextNotes },
            });
            await this._recordOperation(tx, {
                tenantId,
                familyId,
                versionId,
                actorUserId,
                action: 'VERSION_NOTES_UPDATED',
                description: `修改 V${version.version} 的版本说明`,
                metadata: {
                    version: version.version,
                    before: version.notes,
                    after: nextNotes,
                },
            });
            return updated;
        });
    }

    async getOperationLogs(tenantId: string, familyId: string) {
        const family = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId },
            select: { id: true },
        });
        if (!family) throw new NotFoundException('配方不存在');

        return this.prisma.recipeOperationLog.findMany({
            where: { tenantId, familyId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                action: true,
                description: true,
                metadata: true,
                createdAt: true,
                versionId: true,
                actor: { select: { id: true, name: true, phone: true } },
            },
        });
    }

    private async _buildVersionChangeSummary(
        tenantId: string,
        familyId: string,
        sourceVersionId: string,
        recipe: CreateRecipeDto,
    ): Promise<RecipeVersionChangeSummary> {
        const source = await this.getRecipeVersionFormTemplate(tenantId, familyId, sourceVersionId);
        const items: RecipeVersionChangeItem[] = [];
        const dependencyChanges: Array<{
            item: RecipeVersionChangeItem;
            beforeVersionId?: string;
            afterVersionId?: string;
        }> = [];
        const sourceMainComponent =
            source.components.find(
                (component) => component.type === 'MAIN_DOUGH' || component.type === 'BASE_COMPONENT',
            ) ?? source.components[0];

        const fromPercentage = (value: number | null | undefined): number | null =>
            value === null || value === undefined ? null : new Prisma.Decimal(value).div(100).toNumber();

        const sourceIngredients = new Map<
            string,
            { value: number | null; versionId?: string; basis: 'FLOUR_SHARE' | 'RECIPE_RATIO' }
        >();
        for (const ingredient of sourceMainComponent?.ingredients ?? []) {
            sourceIngredients.set(ingredient.name, {
                value: fromPercentage(ingredient.ratio),
                versionId: ingredient.recipeVersionId,
                basis: 'RECIPE_RATIO',
            });
        }
        for (const component of source.components.filter((item) => item.type === 'PRE_DOUGH')) {
            sourceIngredients.set(component.name, {
                value: fromPercentage(component.flourRatioInMainDough),
                versionId: component.recipeVersionId,
                basis: 'FLOUR_SHARE',
            });
        }

        const nextIngredients = new Map<
            string,
            { value: number | null; versionId?: string; basis: 'FLOUR_SHARE' | 'RECIPE_RATIO' }
        >(
            recipe.ingredients.map((ingredient) => [
                ingredient.name,
                {
                    value: ingredient.flourRatio ?? ingredient.ratio ?? null,
                    versionId: ingredient.recipeVersionId,
                    basis:
                        ingredient.flourRatio !== null && ingredient.flourRatio !== undefined
                            ? 'FLOUR_SHARE'
                            : 'RECIPE_RATIO',
                },
            ]),
        );
        const addedIngredients = [...nextIngredients.keys()].filter((name) => !sourceIngredients.has(name));
        const removedIngredients = [...sourceIngredients.keys()].filter((name) => !nextIngredients.has(name));
        items.push(
            ...addedIngredients.map((name) => ({
                kind: 'INGREDIENT_ADDED' as const,
                name,
                after: nextIngredients.get(name)?.value ?? undefined,
                unit: 'RATIO' as const,
                basis: nextIngredients.get(name)?.basis,
            })),
        );
        items.push(
            ...removedIngredients.map((name) => ({
                kind: 'INGREDIENT_REMOVED' as const,
                name,
                before: sourceIngredients.get(name)?.value ?? undefined,
                unit: 'RATIO' as const,
                basis: sourceIngredients.get(name)?.basis,
            })),
        );

        for (const [name, next] of nextIngredients) {
            const previous = sourceIngredients.get(name);
            if (!previous) continue;
            if (previous.value !== null && next.value !== null && Math.abs(previous.value - next.value) >= 0.000001) {
                items.push({
                    kind: 'INGREDIENT_RATIO_CHANGED',
                    name,
                    before: previous.value,
                    after: next.value,
                    unit: 'RATIO',
                    basis: next.basis,
                });
            }
            if (previous.versionId && next.versionId && previous.versionId !== next.versionId) {
                const item: RecipeVersionChangeItem = { kind: 'DEPENDENCY_VERSION_CHANGED', name };
                items.push(item);
                dependencyChanges.push({
                    item,
                    beforeVersionId: previous.versionId,
                    afterVersionId: next.versionId,
                });
            }
        }

        const sourceProducts = new Map((source.products ?? []).map((product) => [product.name, product]));
        const nextProducts = new Map((recipe.products ?? []).map((product) => [product.name, product]));
        const addedProducts = [...nextProducts.keys()].filter((name) => !sourceProducts.has(name));
        const removedProducts = [...sourceProducts.keys()].filter((name) => !nextProducts.has(name));
        items.push(...addedProducts.map((name) => ({ kind: 'PRODUCT_ADDED' as const, name })));
        items.push(...removedProducts.map((name) => ({ kind: 'PRODUCT_REMOVED' as const, name })));

        const normalizeProductIngredients = (
            ingredients: Array<{
                name: string;
                ratio?: number | null;
                weightInGrams?: number | null;
                recipeVersionId?: string;
            }>,
            ratiosArePercentages: boolean,
        ) =>
            ingredients
                .map((ingredient) => ({
                    name: ingredient.name,
                    ratio:
                        ingredient.ratio === null || ingredient.ratio === undefined
                            ? null
                            : ratiosArePercentages
                              ? fromPercentage(ingredient.ratio)
                              : ingredient.ratio,
                    weightInGrams: ingredient.weightInGrams ?? null,
                    recipeVersionId: ingredient.recipeVersionId ?? null,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

        type NormalizedProductIngredient = ReturnType<typeof normalizeProductIngredients>[number];
        const compareProductIngredients = (
            productName: string,
            ingredientType: 'MIX_IN' | 'FILLING' | 'TOPPING',
            previousIngredients: NormalizedProductIngredient[],
            nextIngredientsForProduct: NormalizedProductIngredient[],
        ) => {
            const previousMap = new Map(previousIngredients.map((ingredient) => [ingredient.name, ingredient]));
            const nextMap = new Map(nextIngredientsForProduct.map((ingredient) => [ingredient.name, ingredient]));

            for (const [ingredientName, nextIngredient] of nextMap) {
                const previousIngredient = previousMap.get(ingredientName);
                const usesRatio =
                    nextIngredient.ratio !== null || (previousIngredient ? previousIngredient.ratio !== null : false);
                const unit: RecipeVersionChangeItem['unit'] = usesRatio ? 'RATIO' : 'GRAM';
                const after = usesRatio ? (nextIngredient.ratio ?? 0) : (nextIngredient.weightInGrams ?? 0);

                if (!previousIngredient) {
                    items.push({
                        kind: 'PRODUCT_INGREDIENT_ADDED',
                        name: ingredientName,
                        productName,
                        ingredientType,
                        after,
                        unit,
                    });
                    continue;
                }

                const before = usesRatio ? (previousIngredient.ratio ?? 0) : (previousIngredient.weightInGrams ?? 0);
                if (Math.abs(before - after) >= 0.000001) {
                    items.push({
                        kind: 'PRODUCT_INGREDIENT_AMOUNT_CHANGED',
                        name: ingredientName,
                        productName,
                        ingredientType,
                        before,
                        after,
                        unit,
                    });
                }

                if (
                    previousIngredient.recipeVersionId &&
                    nextIngredient.recipeVersionId &&
                    previousIngredient.recipeVersionId !== nextIngredient.recipeVersionId
                ) {
                    const item: RecipeVersionChangeItem = {
                        kind: 'DEPENDENCY_VERSION_CHANGED',
                        name: ingredientName,
                        productName,
                        ingredientType,
                    };
                    items.push(item);
                    dependencyChanges.push({
                        item,
                        beforeVersionId: previousIngredient.recipeVersionId,
                        afterVersionId: nextIngredient.recipeVersionId,
                    });
                }
            }

            for (const [ingredientName, previousIngredient] of previousMap) {
                if (nextMap.has(ingredientName)) continue;
                const usesRatio = previousIngredient.ratio !== null;
                items.push({
                    kind: 'PRODUCT_INGREDIENT_REMOVED',
                    name: ingredientName,
                    productName,
                    ingredientType,
                    before: usesRatio ? (previousIngredient.ratio ?? 0) : (previousIngredient.weightInGrams ?? 0),
                    unit: usesRatio ? 'RATIO' : 'GRAM',
                });
            }
        };

        for (const [name, next] of nextProducts) {
            const previous = sourceProducts.get(name);
            if (!previous) continue;
            if (Math.abs(previous.baseDoughWeight - next.weight) >= 0.01) {
                items.push({
                    kind: 'PRODUCT_WEIGHT_CHANGED',
                    name,
                    before: previous.baseDoughWeight,
                    after: next.weight,
                    unit: 'GRAM',
                });
            }
            compareProductIngredients(
                name,
                'MIX_IN',
                normalizeProductIngredients(previous.mixIns, true),
                normalizeProductIngredients(next.mixIn ?? [], false),
            );
            compareProductIngredients(
                name,
                'FILLING',
                normalizeProductIngredients(previous.fillings, true),
                normalizeProductIngredients(next.fillings ?? [], false),
            );
            compareProductIngredients(
                name,
                'TOPPING',
                normalizeProductIngredients(previous.toppings, true),
                normalizeProductIngredients(next.toppings ?? [], false),
            );
            if (JSON.stringify(previous.procedure ?? []) !== JSON.stringify(next.procedure ?? [])) {
                items.push({ kind: 'PROCEDURE_CHANGED', scope: 'PRODUCT', name });
            }
        }

        const addFieldChange = (
            field: string,
            previous: number | null | undefined,
            next: number | null | undefined,
            unit?: RecipeVersionChangeItem['unit'],
        ) => {
            const before = previous ?? null;
            const after = next ?? null;
            if (before === null && after === null) return;
            if (Math.abs((before ?? 0) - (after ?? 0)) < 0.000001) return;
            items.push({
                kind: 'FIELD_CHANGED',
                field,
                before: before ?? 0,
                after: after ?? 0,
                unit,
            });
        };
        addFieldChange('targetTemp', source.targetTemp, recipe.targetTemp, 'CELSIUS');
        addFieldChange('lossRatio', fromPercentage(sourceMainComponent?.lossRatio), recipe.lossRatio, 'RATIO');
        addFieldChange('divisionLoss', sourceMainComponent?.divisionLoss, recipe.divisionLoss, 'GRAM');
        if (source.type !== RecipeType.MAIN) {
            const sourceWaterContent = await this._calculateVersionEffectiveWaterPercentage(tenantId, sourceVersionId);
            const nextWaterContent = await this._calculateRecipeDtoEffectiveWaterPercentage(tenantId, recipe);
            addFieldChange('customWaterContent', sourceWaterContent, nextWaterContent, 'PERCENT');
        }
        if (JSON.stringify(sourceMainComponent?.procedure ?? []) !== JSON.stringify(recipe.procedure ?? [])) {
            items.push({ kind: 'PROCEDURE_CHANGED', scope: 'RECIPE' });
        }

        if (dependencyChanges.length > 0) {
            const versionIds = Array.from(
                new Set(
                    dependencyChanges
                        .flatMap((change) => [change.beforeVersionId, change.afterVersionId])
                        .filter((id): id is string => !!id),
                ),
            );
            const versions = await this.prisma.recipeVersion.findMany({
                where: { id: { in: versionIds } },
                select: { id: true, version: true },
            });
            const versionNumberMap = new Map(versions.map((version) => [version.id, version.version]));
            for (const change of dependencyChanges) {
                change.item.beforeVersion = change.beforeVersionId
                    ? versionNumberMap.get(change.beforeVersionId)
                    : undefined;
                change.item.afterVersion = change.afterVersionId
                    ? versionNumberMap.get(change.afterVersionId)
                    : undefined;
            }
        }

        return {
            schemaVersion: 1,
            items: items.length > 0 ? items : [{ kind: 'NO_CHANGES' }],
        };
    }

    private async _calculateVersionEffectiveWaterPercentage(
        tenantId: string,
        versionId: string,
        cache = new Map<string, number>(),
        depth = 0,
    ): Promise<number> {
        if (depth > 8) return 0;
        const cached = cache.get(versionId);
        if (cached !== undefined) return cached;

        const version = await this.prisma.recipeVersion.findFirst({
            where: { id: versionId, family: { tenantId } },
            select: {
                components: {
                    take: 1,
                    select: {
                        customWaterContent: true,
                        ingredients: {
                            select: {
                                ratio: true,
                                flourRatio: true,
                                preDoughVersionId: true,
                                extraVersionId: true,
                                ingredient: { select: { waterContent: true } },
                            },
                        },
                    },
                },
            },
        });
        const component = version?.components[0];
        if (!component) return 0;
        if (component.customWaterContent !== null) {
            const result = component.customWaterContent.toNumber();
            cache.set(versionId, result);
            return result;
        }

        let total = 0;
        let water = 0;
        for (const ingredient of component.ingredients) {
            const ratio = (ingredient.ratio ?? ingredient.flourRatio)?.toNumber() ?? 0;
            if (ratio <= 0) continue;
            let waterFraction = ingredient.ingredient?.waterContent.toNumber() ?? 0;
            const dependencyVersionId = ingredient.preDoughVersionId ?? ingredient.extraVersionId;
            if (dependencyVersionId) {
                waterFraction =
                    (await this._calculateVersionEffectiveWaterPercentage(
                        tenantId,
                        dependencyVersionId,
                        cache,
                        depth + 1,
                    )) / 100;
            }
            total += ratio;
            water += ratio * waterFraction;
        }
        const result = total > 0 ? (water / total) * 100 : 0;
        cache.set(versionId, result);
        return result;
    }

    private async _calculateRecipeDtoEffectiveWaterPercentage(
        tenantId: string,
        recipe: CreateRecipeDto,
    ): Promise<number> {
        if (recipe.customWaterContent !== null && recipe.customWaterContent !== undefined) {
            return recipe.customWaterContent;
        }

        const ingredientIds = recipe.ingredients
            .map((ingredient) => ingredient.ingredientId)
            .filter((id): id is string => !!id);
        const ingredients = await this.prisma.ingredient.findMany({
            where: { id: { in: ingredientIds }, tenantId },
            select: { id: true, waterContent: true },
        });
        const waterByIngredientId = new Map(
            ingredients.map((ingredient) => [ingredient.id, ingredient.waterContent.toNumber()]),
        );
        const versionWaterCache = new Map<string, number>();
        let total = 0;
        let water = 0;

        for (const ingredient of recipe.ingredients) {
            const ratio = ingredient.ratio ?? ingredient.flourRatio ?? 0;
            if (ratio <= 0) continue;
            let waterFraction = ingredient.ingredientId
                ? (waterByIngredientId.get(ingredient.ingredientId) ?? ingredient.waterContent ?? 0)
                : (ingredient.waterContent ?? 0);
            if (ingredient.recipeVersionId) {
                waterFraction =
                    (await this._calculateVersionEffectiveWaterPercentage(
                        tenantId,
                        ingredient.recipeVersionId,
                        versionWaterCache,
                    )) / 100;
            }
            total += ratio;
            water += ratio * waterFraction;
        }
        return total > 0 ? (water / total) * 100 : 0;
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
                include: {
                    versions: {
                        where: pIngredientDto.recipeVersionId
                            ? { OR: [{ id: pIngredientDto.recipeVersionId }, { isActive: true }] }
                            : { isActive: true },
                        select: { id: true },
                    },
                },
            });

            const linkedExtraVersion = pIngredientDto.recipeVersionId
                ? linkedExtra?.versions.find((version) => version.id === pIngredientDto.recipeVersionId)
                : linkedExtra?.versions[0];

            if (linkedExtra && !linkedExtraVersion) {
                throw new BadRequestException(`关联配方 "${linkedExtra.name}" 没有正在使用的版本。`);
            }

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
                    linkedExtraVersionId: linkedExtraVersion?.id,
                },
            });
        }
    }

    private async createVersionInternal(
        tenantId: string,
        familyId: string | null,
        actorUserId: string,
        createRecipeDto: CreateRecipeDto,
        activateNewVersion = false,
        changeSummary: RecipeVersionChangeSummary = {
            schemaVersion: 1,
            items: [{ kind: 'INITIAL_VERSION' }],
        },
        operationAction: RecipeOperationAction = 'VERSION_CREATED',
    ) {
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

                if (activateNewVersion && hasActiveVersion) {
                    await tx.recipeVersion.updateMany({
                        where: { familyId: recipeFamily.id },
                        data: { isActive: false },
                    });
                }

                const recipeVersion = await tx.recipeVersion.create({
                    data: {
                        familyId: recipeFamily.id,
                        version: nextVersionNumber,
                        notes: createRecipeDto.notes || `版本 ${nextVersionNumber}`,
                        changeSummary: changeSummary as unknown as Prisma.InputJsonValue,
                        createdById: actorUserId,
                        isActive: activateNewVersion || !hasActiveVersion,
                    },
                });

                await tx.componentIngredient.updateMany({
                    where: { preDoughId: recipeFamily.id, preDoughVersionId: null },
                    data: { preDoughVersionId: recipeVersion.id },
                });
                await tx.componentIngredient.updateMany({
                    where: { extraId: recipeFamily.id, extraVersionId: null },
                    data: { extraVersionId: recipeVersion.id },
                });
                await tx.productIngredient.updateMany({
                    where: { linkedExtraId: recipeFamily.id, linkedExtraVersionId: null },
                    data: { linkedExtraVersionId: recipeVersion.id },
                });

                const finalFamily = await this.createVersionContents(tenantId, recipeVersion.id, createRecipeDto, tx);

                const waterContent = this._calculateWaterContent(finalFamily as unknown as WaterCalcFamily);
                // [核心新增] 同步自制原料
                await this._syncSelfMadeIngredient(tx, tenantId, recipeFamily.id, name, type, waterContent);

                await this._syncDefaultProduct(tx, recipeVersion.id, name, type);

                const description =
                    operationAction === 'RECIPE_CREATED'
                        ? `创建配方并生成 V${recipeVersion.version}`
                        : `新建配方版本 V${recipeVersion.version}${activateNewVersion ? '，并设为使用中' : ''}`;
                await this._recordOperation(tx, {
                    tenantId,
                    familyId: recipeFamily.id,
                    versionId: recipeVersion.id,
                    actorUserId,
                    action: operationAction,
                    description,
                    metadata: {
                        targetVersion: recipeVersion.version,
                        isActive: recipeVersion.isActive,
                        changeSummary: changeSummary as unknown as Prisma.InputJsonValue,
                    },
                });

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

            const linkedVersion = ingredientDto.recipeVersionId
                ? linkedFamily?.versions.find((version) => version.id === ingredientDto.recipeVersionId)
                : linkedFamily?.versions.find((version) => version.isActive);

            if (linkedFamily && !linkedVersion) {
                throw new BadRequestException(`关联配方 "${linkedFamily.name}" 没有正在使用的版本。`);
            }

            const ingredientId = linkedFamily ? undefined : ingredientDto.ingredientId;
            const preDoughId = linkedFamily?.type === 'PRE_DOUGH' ? linkedFamily.id : undefined;
            const extraId = linkedFamily?.type === 'EXTRA' ? linkedFamily.id : undefined;
            const preDoughVersionId = preDoughId ? linkedVersion?.id : undefined;
            const extraVersionId = extraId ? linkedVersion?.id : undefined;

            if (!ingredientId && !preDoughId && !extraId) {
                throw new BadRequestException(
                    `原料 "${ingredientDto.name}" 无法被识别，它既不是基础原料，也不是一个有效的 PRE_DOUGH 或 EXTRA 配方。`,
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
                    preDoughVersionId,
                    extraId: extraId,
                    extraVersionId,
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
        await this.entitlements.getSummary(tenantId);
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
                    versions: true,
                    usedInComponentsAsPreDough: true,
                    usedInComponentsAsExtra: true,
                    usedInProducts: true,
                },
            },
            usedInComponentsAsPreDough: {
                where: { component: { recipeVersion: { isActive: true, family: { deletedAt: null } } } },
                select: {
                    component: { select: { recipeVersion: { select: { family: { select: { name: true } } } } } },
                },
            },
            usedInComponentsAsExtra: {
                where: { component: { recipeVersion: { isActive: true, family: { deletedAt: null } } } },
                select: {
                    component: { select: { recipeVersion: { select: { family: { select: { name: true } } } } } },
                },
            },
            usedInProducts: {
                where: { product: { recipeVersion: { isActive: true, family: { deletedAt: null } } } },
                select: { product: { select: { recipeVersion: { select: { family: { select: { name: true } } } } } } },
            },
        };

        const rawFamilies = await this.prisma.recipeFamily.findMany({
            // [核心修复] 移除 deletedAt: null，使列表包含已停用的配方
            where: { tenantId },
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

                const referencedByNames = Array.from(
                    new Set([
                        ...family.usedInComponentsAsPreDough.map((item) => item.component.recipeVersion.family.name),
                        ...family.usedInComponentsAsExtra.map((item) => item.component.recipeVersion.family.name),
                        ...family.usedInProducts.map((item) => item.product.recipeVersion.family.name),
                    ]),
                ).sort((a, b) => a.localeCompare(b));

                const listMetadata = {
                    productNames: activeVersion?.products.map((product) => product.name) ?? [],
                    referencedByNames,
                    versionCount: family._count.versions,
                    activeVersion: activeVersion
                        ? {
                              version: activeVersion.version,
                              notes: activeVersion.notes,
                              changeSummary: activeVersion.changeSummary,
                          }
                        : null,
                };

                if (!activeVersion || activeVersion.products.length === 0) {
                    return {
                        ...family,
                        productCount,
                        ingredientCount,
                        productionTaskCount: 0,
                        usageCount,
                        ...listMetadata,
                    };
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
                    ...listMetadata,
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
                // [核心修复] 返回 deletedAt 字段，供前端判断停用状态
                deletedAt: family.deletedAt,
                waterContent: calculatedWater, // 返回计算后的含水量
                // versions: family.versions, // 不返回 versions 以减少数据量
                productCount: family.productCount,
                ingredientCount: family.ingredientCount,
                productionTaskCount: family.productionTaskCount,
                usageCount: family.usageCount,
                productNames: family.productNames,
                referencedByNames: family.referencedByNames,
                versionCount: family.versionCount,
                activeVersion: family.activeVersion,
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
        const entitlement = await this.entitlements.getSummary(tenantId);
        const recipeFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId,
                deletedAt: null,
                ...(entitlement.fullAccess
                    ? {}
                    : { OR: [{ type: { not: RecipeType.MAIN } }, { freeTierEnabled: true }] }),
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
                            },
                        });
                    } catch {
                        // 可能已由并发请求创建，忽略并继续使用配方数据。
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
            include: {
                ...recipeFamilyWithDetailsInclude,
                _count: {
                    select: {
                        usedInComponentsAsPreDough: true,
                        usedInComponentsAsExtra: true,
                        usedInProducts: true,
                    },
                },
            },
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        const usageCount =
            (family._count?.usedInComponentsAsPreDough || 0) +
            (family._count?.usedInComponentsAsExtra || 0) +
            (family._count?.usedInProducts || 0);

        const processedFamily = {
            ...family,
            usageCount,
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
                                linkedPreDough: true,
                                linkedPreDoughVersion: {
                                    include: {
                                        components: {
                                            include: {
                                                ingredients: { include: { ingredient: true } },
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
                                recipeVersionId: ing.preDoughVersionId ?? ing.extraVersionId ?? undefined,
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
                    const preDoughRecipe = ing.linkedPreDoughVersion?.components[0];

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
                            recipeVersionId: ing.preDoughVersionId ?? undefined,
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
                        recipeVersionId: ing.extraVersionId ?? undefined,
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
                                recipeVersionId: ing.preDoughVersionId ?? ing.extraVersionId ?? undefined,
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
                                recipeVersionId: ing.linkedExtraVersionId ?? undefined,
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

    private async buildDependencyUpgradePlan(
        tenantId: string,
        familyId: string,
        versionId: string,
    ): Promise<DependencyUpgradePlanDto> {
        const sourceVersion = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId,
                isActive: true,
                family: { tenantId, deletedAt: null },
            },
            select: { id: true, version: true },
        });

        if (!sourceVersion) {
            throw new BadRequestException('只有当前使用中的配方版本可以检查关联更新。');
        }

        const activeVersions = await this.prisma.recipeVersion.findMany({
            where: {
                isActive: true,
                family: { tenantId, deletedAt: null },
            },
            select: {
                id: true,
                version: true,
                family: { select: { id: true, name: true, type: true } },
                components: {
                    select: {
                        ingredients: {
                            select: {
                                preDoughId: true,
                                preDoughVersionId: true,
                                extraId: true,
                                extraVersionId: true,
                            },
                        },
                    },
                },
                products: {
                    where: { deletedAt: null },
                    select: {
                        ingredients: {
                            select: {
                                linkedExtraId: true,
                                linkedExtraVersionId: true,
                            },
                        },
                    },
                },
            },
        });

        const activeVersionByFamily = new Map(activeVersions.map((version) => [version.family.id, version]));
        const versionsByNewest = await this.prisma.recipeVersion.findMany({
            where: { family: { tenantId, deletedAt: null } },
            orderBy: { version: 'desc' },
            select: { id: true, familyId: true, version: true },
        });
        const latestVersionByFamily = new Map<string, { id: string; version: number }>();
        for (const version of versionsByNewest) {
            if (!latestVersionByFamily.has(version.familyId)) {
                latestVersionByFamily.set(version.familyId, version);
            }
        }
        const parentsByChild = new Map<string, Map<string, Set<string | null>>>();

        const addDependency = (
            childFamilyId: string | null,
            pinnedVersionId: string | null,
            parentFamilyId: string,
        ) => {
            if (!childFamilyId || childFamilyId === parentFamilyId) return;
            const parentMap = parentsByChild.get(childFamilyId) ?? new Map<string, Set<string | null>>();
            const pinnedVersions = parentMap.get(parentFamilyId) ?? new Set<string | null>();
            pinnedVersions.add(pinnedVersionId);
            parentMap.set(parentFamilyId, pinnedVersions);
            parentsByChild.set(childFamilyId, parentMap);
        };

        for (const parentVersion of activeVersions) {
            for (const component of parentVersion.components) {
                for (const ingredient of component.ingredients) {
                    addDependency(ingredient.preDoughId, ingredient.preDoughVersionId, parentVersion.family.id);
                    addDependency(ingredient.extraId, ingredient.extraVersionId, parentVersion.family.id);
                }
            }
            for (const product of parentVersion.products) {
                for (const ingredient of product.ingredients) {
                    addDependency(ingredient.linkedExtraId, ingredient.linkedExtraVersionId, parentVersion.family.id);
                }
            }
        }

        const affected = new Map<string, DependencyUpgradeItemDto>();
        const queue: Array<{ familyId: string; depth: number; isSource: boolean }> = [
            { familyId, depth: 0, isSource: true },
        ];

        while (queue.length > 0) {
            const current = queue.shift()!;
            const parents = parentsByChild.get(current.familyId);
            if (!parents) continue;

            for (const [parentFamilyId, pinnedVersions] of parents) {
                if (parentFamilyId === familyId) continue;
                if (current.isSource && [...pinnedVersions].every((pinned) => pinned === versionId)) continue;

                const existingItem = affected.get(parentFamilyId);
                if (existingItem) {
                    if (!existingItem.updatedDependencyFamilyIds.includes(current.familyId)) {
                        existingItem.updatedDependencyFamilyIds.push(current.familyId);
                    }
                    continue;
                }

                const activeParent = activeVersionByFamily.get(parentFamilyId);
                if (!activeParent) continue;
                const latestParent = latestVersionByFamily.get(parentFamilyId) ?? activeParent;

                const item: DependencyUpgradeItemDto = {
                    familyId: parentFamilyId,
                    familyName: activeParent.family.name,
                    type: activeParent.family.type,
                    currentVersionId: latestParent.id,
                    updatedDependencyFamilyIds: [current.familyId],
                    depth: current.depth + 1,
                };
                affected.set(parentFamilyId, item);
                queue.push({ familyId: parentFamilyId, depth: item.depth, isSource: false });
            }
        }

        return {
            sourceFamilyId: familyId,
            sourceVersionId: versionId,
            affectedRecipes: Array.from(affected.values()).sort(
                (a, b) => a.depth - b.depth || a.familyName.localeCompare(b.familyName, 'zh-CN'),
            ),
        };
    }

    getDependencyUpgradePlan(tenantId: string, familyId: string, versionId: string) {
        return this.buildDependencyUpgradePlan(tenantId, familyId, versionId);
    }

    async getPendingDependencyUpgrades(tenantId: string, familyId: string): Promise<PendingDependencyUpgradePlanDto> {
        const currentVersion = await this.prisma.recipeVersion.findFirst({
            where: { familyId, isActive: true, family: { tenantId, deletedAt: null } },
            select: {
                id: true,
                version: true,
                family: { select: { name: true } },
                components: {
                    select: {
                        ingredients: {
                            select: {
                                preDoughId: true,
                                preDoughVersionId: true,
                                extraId: true,
                                extraVersionId: true,
                            },
                        },
                    },
                },
                products: {
                    where: { deletedAt: null },
                    select: {
                        ingredients: {
                            select: { linkedExtraId: true, linkedExtraVersionId: true },
                        },
                    },
                },
            },
        });
        if (!currentVersion) throw new NotFoundException('当前配方没有使用中的版本');

        const pinnedByFamily = new Map<string, string | null>();
        for (const component of currentVersion.components) {
            for (const ingredient of component.ingredients) {
                if (ingredient.preDoughId) {
                    pinnedByFamily.set(ingredient.preDoughId, ingredient.preDoughVersionId);
                }
                if (ingredient.extraId) {
                    pinnedByFamily.set(ingredient.extraId, ingredient.extraVersionId);
                }
            }
        }
        for (const product of currentVersion.products) {
            for (const ingredient of product.ingredients) {
                if (ingredient.linkedExtraId) {
                    pinnedByFamily.set(ingredient.linkedExtraId, ingredient.linkedExtraVersionId);
                }
            }
        }

        const activeDependencies = await this.prisma.recipeVersion.findMany({
            where: {
                familyId: { in: [...pinnedByFamily.keys()] },
                isActive: true,
                family: { tenantId, deletedAt: null },
            },
            select: {
                id: true,
                version: true,
                familyId: true,
                family: { select: { name: true } },
            },
        });
        const latestVersion = await this.prisma.recipeVersion.findFirst({
            where: { familyId },
            orderBy: { version: 'desc' },
            select: { id: true, version: true },
        });

        return {
            familyId,
            familyName: currentVersion.family.name,
            currentVersionId: latestVersion?.id ?? currentVersion.id,
            dependencies: activeDependencies
                .filter((dependency) => pinnedByFamily.get(dependency.familyId) !== dependency.id)
                .map((dependency) => ({
                    familyId: dependency.familyId,
                    familyName: dependency.family.name,
                }))
                .sort((a, b) => a.familyName.localeCompare(b.familyName, 'zh-CN')),
        };
    }

    async applyPendingDependencyUpgrades(
        tenantId: string,
        familyId: string,
        actorUserId: string,
    ): Promise<ApplyDependencyUpgradeResultDto> {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const plan = await this.getPendingDependencyUpgrades(tenantId, familyId);
        if (plan.dependencies.length === 0) return { upgradedRecipes: [] };

        return this.prisma.$transaction(
            async (tx) => {
                const activeVersions = await tx.recipeVersion.findMany({
                    where: { isActive: true, family: { tenantId, deletedAt: null } },
                    select: { id: true, familyId: true },
                });
                const activeVersionIds = new Map(activeVersions.map((version) => [version.familyId, version.id]));
                const upgraded = await this.cloneActiveVersionWithCurrentDependencies(
                    tx,
                    tenantId,
                    actorUserId,
                    {
                        familyId,
                        familyName: plan.familyName,
                        type: RecipeType.MAIN,
                        currentVersionId: plan.currentVersionId,
                        updatedDependencyFamilyIds: plan.dependencies.map((dependency) => dependency.familyId),
                        depth: 0,
                    },
                    activeVersionIds,
                );
                const family = await tx.recipeFamily.findUnique({
                    where: { id: familyId },
                    include: recipeFamilyWithDetailsInclude,
                });
                if (family && family.type !== RecipeType.MAIN) {
                    const waterContent = this._calculateWaterContent(family as unknown as WaterCalcFamily);
                    await this._syncSelfMadeIngredient(tx, tenantId, family.id, family.name, family.type, waterContent);
                }
                return { upgradedRecipes: [upgraded] };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    private async cloneActiveVersionWithCurrentDependencies(
        tx: Prisma.TransactionClient,
        tenantId: string,
        actorUserId: string,
        planItem: DependencyUpgradeItemDto,
        activeVersionIds: Map<string, string>,
    ) {
        const source = await tx.recipeVersion.findFirst({
            where: {
                familyId: planItem.familyId,
                family: { tenantId, deletedAt: null },
            },
            orderBy: { version: 'desc' },
            include: {
                family: true,
                components: { include: { ingredients: true } },
                products: {
                    where: { deletedAt: null },
                    include: { ingredients: true },
                },
            },
        });

        if (!source || source.id !== planItem.currentVersionId) {
            throw new BadRequestException(`配方“${planItem.familyName}”已发生变化，请刷新后重试。`);
        }

        const latestVersion = await tx.recipeVersion.findFirst({
            where: { familyId: planItem.familyId },
            orderBy: { version: 'desc' },
            select: { version: true },
        });
        const nextVersion = (latestVersion?.version ?? 0) + 1;

        await tx.recipeVersion.updateMany({
            where: { familyId: planItem.familyId },
            data: { isActive: false },
        });

        const dependencyFamilyIds = new Set<string>();
        for (const component of source.components) {
            for (const ingredient of component.ingredients) {
                if (ingredient.preDoughId) dependencyFamilyIds.add(ingredient.preDoughId);
                if (ingredient.extraId) dependencyFamilyIds.add(ingredient.extraId);
            }
        }
        for (const product of source.products) {
            for (const ingredient of product.ingredients) {
                if (ingredient.linkedExtraId) dependencyFamilyIds.add(ingredient.linkedExtraId);
            }
        }
        const changedDependencyIds = [...dependencyFamilyIds].filter((dependencyFamilyId) => {
            const activeVersionId = activeVersionIds.get(dependencyFamilyId);
            if (!activeVersionId) return false;
            return (
                source.components.some((component) =>
                    component.ingredients.some(
                        (ingredient) =>
                            (ingredient.preDoughId === dependencyFamilyId &&
                                ingredient.preDoughVersionId !== activeVersionId) ||
                            (ingredient.extraId === dependencyFamilyId &&
                                ingredient.extraVersionId !== activeVersionId),
                    ),
                ) ||
                source.products.some((product) =>
                    product.ingredients.some(
                        (ingredient) =>
                            ingredient.linkedExtraId === dependencyFamilyId &&
                            ingredient.linkedExtraVersionId !== activeVersionId,
                    ),
                )
            );
        });
        const summaryDependencyIds = [...new Set([...changedDependencyIds, ...planItem.updatedDependencyFamilyIds])];
        const changedDependencies = await tx.recipeFamily.findMany({
            where: { id: { in: summaryDependencyIds }, tenantId },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
        });
        const changeSummary: RecipeVersionChangeSummary = {
            schemaVersion: 1,
            items: changedDependencies.map((dependency) => ({
                kind: 'DEPENDENCY_VERSION_CHANGED',
                name: dependency.name,
            })),
        };

        const createdVersion = await tx.recipeVersion.create({
            data: {
                familyId: planItem.familyId,
                version: nextVersion,
                notes: '更新原料配方',
                changeSummary: changeSummary as unknown as Prisma.InputJsonValue,
                createdById: actorUserId,
                isActive: true,
            },
        });

        const resolveVersionId = (dependencyFamilyId: string | null): string | null => {
            if (!dependencyFamilyId) return null;
            const dependencyVersionId = activeVersionIds.get(dependencyFamilyId);
            if (!dependencyVersionId) {
                throw new BadRequestException('依赖配方没有正在使用的版本，无法完成关联更新。');
            }
            return dependencyVersionId;
        };

        for (const component of source.components) {
            const createdComponent = await tx.recipeComponent.create({
                data: {
                    recipeVersionId: createdVersion.id,
                    name: component.name,
                    targetTemp: component.targetTemp,
                    lossRatio: component.lossRatio,
                    divisionLoss: component.divisionLoss,
                    customWaterContent: component.customWaterContent,
                    procedure: component.procedure,
                },
            });

            if (component.ingredients.length > 0) {
                await tx.componentIngredient.createMany({
                    data: component.ingredients.map((ingredient) => ({
                        componentId: createdComponent.id,
                        ratio: ingredient.ratio,
                        flourRatio: ingredient.flourRatio,
                        ingredientId: ingredient.ingredientId,
                        preDoughId: ingredient.preDoughId,
                        preDoughVersionId: resolveVersionId(ingredient.preDoughId),
                        extraId: ingredient.extraId,
                        extraVersionId: resolveVersionId(ingredient.extraId),
                    })),
                });
            }
        }

        for (const product of source.products) {
            const createdProduct = await tx.product.create({
                data: {
                    recipeVersionId: createdVersion.id,
                    name: product.name,
                    baseDoughWeight: product.baseDoughWeight,
                    procedure: product.procedure,
                },
            });

            if (product.ingredients.length > 0) {
                await tx.productIngredient.createMany({
                    data: product.ingredients.map((ingredient) => ({
                        productId: createdProduct.id,
                        type: ingredient.type,
                        ingredientId: ingredient.ingredientId,
                        ratio: ingredient.ratio,
                        weightInGrams: ingredient.weightInGrams,
                        linkedExtraId: ingredient.linkedExtraId,
                        linkedExtraVersionId: resolveVersionId(ingredient.linkedExtraId),
                    })),
                });
            }
        }

        activeVersionIds.set(planItem.familyId, createdVersion.id);
        await this._recordOperation(tx, {
            tenantId,
            familyId: planItem.familyId,
            versionId: createdVersion.id,
            actorUserId,
            action: 'DEPENDENCY_UPDATED',
            description: '更新原料配方',
            metadata: {
                targetVersion: createdVersion.version,
                changeSummary: changeSummary as unknown as Prisma.InputJsonValue,
            },
        });
        return {
            familyId: planItem.familyId,
            familyName: planItem.familyName,
            versionId: createdVersion.id,
            version: createdVersion.version,
        };
    }

    async applyDependencyUpgrades(
        tenantId: string,
        familyId: string,
        versionId: string,
        actorUserId: string,
    ): Promise<ApplyDependencyUpgradeResultDto> {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const plan = await this.buildDependencyUpgradePlan(tenantId, familyId, versionId);
        if (plan.affectedRecipes.length === 0) {
            return { upgradedRecipes: [] };
        }

        return this.prisma.$transaction(
            async (tx) => {
                const activeVersions = await tx.recipeVersion.findMany({
                    where: { isActive: true, family: { tenantId, deletedAt: null } },
                    select: { id: true, familyId: true },
                });
                const activeVersionIds = new Map(activeVersions.map((version) => [version.familyId, version.id]));
                if (activeVersionIds.get(familyId) !== versionId) {
                    throw new BadRequestException('源配方版本已发生变化，请刷新后重试。');
                }
                const upgradedRecipes: ApplyDependencyUpgradeResultDto['upgradedRecipes'] = [];

                for (const planItem of plan.affectedRecipes) {
                    upgradedRecipes.push(
                        await this.cloneActiveVersionWithCurrentDependencies(
                            tx,
                            tenantId,
                            actorUserId,
                            planItem,
                            activeVersionIds,
                        ),
                    );
                }

                for (const upgraded of upgradedRecipes) {
                    const family = await tx.recipeFamily.findUnique({
                        where: { id: upgraded.familyId },
                        include: recipeFamilyWithDetailsInclude,
                    });
                    if (family && family.type !== RecipeType.MAIN) {
                        const waterContent = this._calculateWaterContent(family as unknown as WaterCalcFamily);
                        await this._syncSelfMadeIngredient(
                            tx,
                            tenantId,
                            family.id,
                            family.name,
                            family.type,
                            waterContent,
                        );
                    }
                }

                return { upgradedRecipes };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    async activateVersion(tenantId: string, familyId: string, versionId: string, actorUserId: string) {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const versionToActivate = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId: familyId,
                family: {
                    tenantId: tenantId,
                },
            },
            select: { id: true, version: true, isActive: true },
        });

        if (!versionToActivate) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        return this.prisma.$transaction(async (tx) => {
            const previousActive = await tx.recipeVersion.findFirst({
                where: { familyId, isActive: true },
                select: { id: true, version: true },
            });
            await tx.recipeVersion.updateMany({
                where: { familyId: familyId },
                data: { isActive: false },
            });

            const activatedVersion = await tx.recipeVersion.update({
                where: { id: versionId },
                data: { isActive: true },
            });

            const family = await tx.recipeFamily.findUnique({
                where: { id: familyId },
                include: recipeFamilyWithDetailsInclude,
            });
            if (family && family.type !== RecipeType.MAIN) {
                const waterContent = this._calculateWaterContent(family as unknown as WaterCalcFamily);
                await this._syncSelfMadeIngredient(tx, tenantId, family.id, family.name, family.type, waterContent);
            }

            if (!versionToActivate.isActive) {
                await this._recordOperation(tx, {
                    tenantId,
                    familyId,
                    versionId,
                    actorUserId,
                    action: 'VERSION_ACTIVATED',
                    description: `启用 V${versionToActivate.version}`,
                    metadata: {
                        previousVersion: previousActive?.version ?? null,
                        activatedVersion: versionToActivate.version,
                    },
                });
            }

            return activatedVersion;
        });
    }

    async remove(familyId: string) {
        const family = await this.prisma.recipeFamily.findUnique({
            where: { id: familyId },
            select: { id: true },
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        throw new BadRequestException('配方及历史版本不可物理删除，请使用“停用配方”。');
    }

    async discontinue(tenantId: string, familyId: string, actorUserId: string) {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const family = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId },
        });
        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }
        return this.prisma.$transaction(async (tx) => {
            const updated = await tx.recipeFamily.update({
                where: { id: familyId },
                data: { deletedAt: new Date() },
            });
            await this._recordOperation(tx, {
                tenantId,
                familyId,
                actorUserId,
                action: 'RECIPE_DISCONTINUED',
                description: '停用配方',
            });
            return updated;
        });
    }

    async restore(tenantId: string, familyId: string, actorUserId: string) {
        const family = await this.prisma.recipeFamily.findFirst({
            where: { id: familyId, tenantId },
            select: { id: true, deletedAt: true, type: true },
        });

        if (!family) {
            throw new NotFoundException(`ID为 "${familyId}" 的配方不存在`);
        }

        if (family.deletedAt === null) {
            throw new BadRequestException('该配方未被弃用，无需恢复。');
        }

        await this.entitlements.assertCanCreateRecipe(tenantId, family.type);

        return this.prisma.$transaction(async (tx) => {
            const updated = await tx.recipeFamily.update({
                where: { id: familyId },
                data: { deletedAt: null },
            });
            await this._recordOperation(tx, {
                tenantId,
                familyId,
                actorUserId,
                action: 'RECIPE_RESTORED',
                description: '恢复配方',
            });
            return updated;
        });
    }

    async deleteVersion(tenantId: string, familyId: string, versionId: string) {
        await this.entitlements.assertRecipeWritable(tenantId, familyId);
        const version = await this.prisma.recipeVersion.findFirst({
            where: {
                id: versionId,
                familyId,
                family: { tenantId },
            },
            select: { id: true },
        });

        if (!version) {
            throw new NotFoundException('指定的配方版本不存在');
        }

        throw new BadRequestException('历史配方版本不可删除，可以停用整个配方。');
    }

    private async preloadLinkedFamilies(
        tenantId: string,
        ingredients: ComponentIngredientDto[],
        tx: Prisma.TransactionClient,
    ): Promise<Map<string, PreloadedRecipeFamily>> {
        const linkedRecipeNames = ingredients.map((ing) => ing.name);
        const requestedVersionIds = ingredients
            .map((ingredient) => ingredient.recipeVersionId)
            .filter((id): id is string => !!id);

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
                    where: {
                        OR: [{ isActive: true }, { id: { in: requestedVersionIds } }],
                    },
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
                    throw new BadRequestException(`原料 "${ing.name}" 是一个基础原料，不能使用面粉比例(flourRatio)。`);
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
