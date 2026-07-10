import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import {
    Prisma,
    ProductIngredientType,
    RecipeDraftStatus,
    RecipeEditorSessionStatus,
    TenantRole,
} from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RecipesService } from '../recipes/recipes.service';
import { BatchImportRecipeDto } from '../recipes/dto/batch-import-recipe.dto';
import { CreateRecipeDto } from '../recipes/dto/create-recipe.dto';
import { IngredientsService } from '../ingredients/ingredients.service';
import { UpsertRecipeDraftDto } from './dto/recipe-editor.dto';

type EditorSessionContext = {
    id: string;
    token: string;
    tenantId: string;
    userId: string;
    actorRole: string;
    tenantRole: string | null;
};

@Injectable()
export class RecipeEditorService {
    private readonly editorLeaseMs = 2 * 60 * 1000;

    constructor(
        private readonly prisma: PrismaService,
        private readonly recipesService: RecipesService,
        private readonly ingredientsService: IngredientsService,
    ) {}

    async createLoginSession() {
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
        const session = await this.prisma.recipeEditorSession.create({
            data: {
                token: randomBytes(24).toString('hex'),
                expiresAt,
            },
            select: {
                id: true,
                token: true,
                status: true,
                expiresAt: true,
            },
        });

        return {
            ...session,
            code: session.token.slice(0, 6).toUpperCase(),
            scanPayload: `RE:${session.id}:${session.token}`,
        };
    }

    async getSessionStatus(sessionId: string, token: string) {
        const session = await this.findSession(sessionId, token);
        if (session.status === RecipeEditorSessionStatus.PENDING && session.expiresAt <= new Date()) {
            await this.prisma.recipeEditorSession.update({
                where: { id: session.id },
                data: { status: RecipeEditorSessionStatus.EXPIRED },
            });
            return { status: RecipeEditorSessionStatus.EXPIRED };
        }

        return {
            status: session.status,
            tenantId: session.tenantId,
            actorRole: session.actorRole,
            expiresAt: session.expiresAt,
        };
    }

    async approveSession(sessionId: string, token: string, userId: string, tenantId: string, tenantRole: TenantRole) {
        if (tenantRole !== TenantRole.OWNER) {
            throw new ForbiddenException('只有店主可以授权电脑端配方编辑器。');
        }

        return this.prisma.$transaction(
            async (tx) => {
                const now = new Date();
                const session = await tx.recipeEditorSession.findFirst({ where: { id: sessionId, token } });
                if (!session || session.status !== RecipeEditorSessionStatus.PENDING) {
                    throw new BadRequestException('该登录二维码已失效，请在电脑端刷新后重试。');
                }
                if (session.expiresAt <= now) {
                    await tx.recipeEditorSession.update({
                        where: { id: session.id },
                        data: { status: RecipeEditorSessionStatus.EXPIRED },
                    });
                    throw new BadRequestException('该登录二维码已过期，请在电脑端刷新后重试。');
                }
                await this.expireStaleTenantSessions(tx, tenantId, now);
                const activeSession = await tx.recipeEditorSession.findFirst({
                    where: {
                        tenantId,
                        status: RecipeEditorSessionStatus.APPROVED,
                        expiresAt: { gt: now },
                    },
                    select: { id: true },
                });
                if (activeSession) {
                    throw new BadRequestException('该店铺正在其他电脑编辑，请稍后再试。');
                }

                return tx.recipeEditorSession.update({
                    where: { id: session.id },
                    data: {
                        status: RecipeEditorSessionStatus.APPROVED,
                        tenantId,
                        userId,
                        tenantRole,
                        expiresAt: this.nextLeaseExpiry(),
                        approvedAt: now,
                    },
                    select: { id: true, status: true, tenantId: true, expiresAt: true },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    async approveSessionByCode(code: string, userId: string, tenantId: string, tenantRole: TenantRole) {
        if (!/^[0-9A-Fa-f]{6}$/.test(code)) {
            throw new BadRequestException('验证码格式不正确');
        }

        const session = await this.prisma.recipeEditorSession.findFirst({
            where: {
                token: { startsWith: code.toLowerCase() },
                status: RecipeEditorSessionStatus.PENDING,
                expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: 'desc' },
        });

        if (!session) {
            throw new BadRequestException('验证码无效或已过期，请在电脑端刷新后重试。');
        }

        return this.approveSession(session.id, session.token, userId, tenantId, tenantRole);
    }

    async createAdminSession(tenantId: string, actorUserId: string) {
        const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
        if (!tenant) {
            throw new NotFoundException('店铺不存在');
        }

        return this.prisma.$transaction(
            async (tx) => {
                const now = new Date();
                await this.expireStaleTenantSessions(tx, tenantId, now);
                const activeSession = await tx.recipeEditorSession.findFirst({
                    where: {
                        tenantId,
                        status: RecipeEditorSessionStatus.APPROVED,
                        expiresAt: { gt: now },
                    },
                    select: { id: true },
                });
                if (activeSession) {
                    throw new BadRequestException('该店铺正在其他电脑编辑，请稍后再试。');
                }
                return tx.recipeEditorSession.create({
                    data: {
                        token: randomBytes(24).toString('hex'),
                        status: RecipeEditorSessionStatus.APPROVED,
                        tenantId,
                        userId: actorUserId,
                        actorRole: 'SUPER_ADMIN',
                        expiresAt: this.nextLeaseExpiry(),
                        approvedAt: now,
                    },
                    select: { id: true, token: true, expiresAt: true },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
    }

    async exchangeSessionToken(sessionId: string, token: string) {
        const session = await this.getApprovedSession(sessionId, token, false);
        const nextToken = randomBytes(24).toString('hex');
        const updated = await this.prisma.recipeEditorSession.update({
            where: { id: session.id },
            data: { token: nextToken, expiresAt: this.nextLeaseExpiry() },
            select: { id: true, token: true, expiresAt: true },
        });
        return updated;
    }

    async heartbeat(sessionId: string, token: string) {
        const session = await this.getApprovedSession(sessionId, token, false);
        return this.prisma.recipeEditorSession.update({
            where: { id: session.id },
            data: { expiresAt: this.nextLeaseExpiry() },
            select: { id: true, expiresAt: true },
        });
    }

    async getEditorMe(sessionId: string, token: string) {
        const session = await this.getApprovedSession(sessionId, token);
        const tenant = await this.prisma.tenant.findUnique({
            where: { id: session.tenantId },
            select: { id: true, name: true },
        });

        return {
            sessionId: session.id,
            actorRole: session.actorRole,
            tenantRole: session.tenantRole,
            tenant,
        };
    }

    async listDrafts(sessionId: string, token: string) {
        const session = await this.getApprovedSession(sessionId, token);
        return this.prisma.recipeDraft.findMany({
            where: { tenantId: session.tenantId },
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                title: true,
                status: true,
                payload: true,
                syncedAt: true,
                createdAt: true,
                updatedAt: true,
            },
        });
    }

    async listRecipes(sessionId: string, token: string) {
        const session = await this.getApprovedSession(sessionId, token);
        return this.recipesService.getRecipeEditorCatalog(session.tenantId);
    }

    async listIngredients(sessionId: string, token: string) {
        const session = await this.getApprovedSession(sessionId, token);
        return this.ingredientsService.getEditorCatalog(session.tenantId);
    }

    async createDraft(sessionId: string, token: string, dto: UpsertRecipeDraftDto) {
        const session = await this.getApprovedSession(sessionId, token);
        return this.prisma.recipeDraft.create({
            data: {
                tenantId: session.tenantId,
                createdById: session.userId,
                actorRole: session.actorRole,
                title: dto.title,
                payload: dto.payload as unknown as Prisma.InputJsonValue,
            },
        });
    }

    async updateDraft(sessionId: string, token: string, draftId: string, dto: UpsertRecipeDraftDto) {
        const session = await this.getApprovedSession(sessionId, token);
        const draft = await this.getDraftForSession(draftId, session.tenantId);
        if (draft.status === RecipeDraftStatus.SYNCED) {
            throw new BadRequestException('已同步的草稿不可继续修改，请新建草稿。');
        }

        return this.prisma.recipeDraft.update({
            where: { id: draft.id },
            data: {
                title: dto.title,
                payload: dto.payload as unknown as Prisma.InputJsonValue,
            },
        });
    }

    async syncDraft(sessionId: string, token: string, draftId: string) {
        const session = await this.getApprovedSession(sessionId, token);
        const draft = await this.getDraftForSession(draftId, session.tenantId);
        if (draft.status === RecipeDraftStatus.SYNCED) {
            throw new BadRequestException('该草稿已经同步过。');
        }

        const payload = draft.payload as unknown as {
            recipes?: BatchImportRecipeDto[];
            targets?: Array<{ recipeName: string; familyId?: string; baseVersionId?: string }>;
        };
        const recipes = Array.isArray(payload.recipes) ? payload.recipes : [];
        if (recipes.length === 0) {
            throw new BadRequestException('草稿中没有可同步的配方。');
        }

        const recipeNames = recipes
            .map((recipe) => recipe.name?.trim())
            .filter((name): name is string => Boolean(name));
        if (new Set(recipeNames).size !== recipeNames.length) {
            throw new BadRequestException('草稿中存在同名配方，请修改后再发布。');
        }

        const targetByName = new Map((payload.targets ?? []).map((target) => [target.recipeName, target]));
        const targetFamilyIds = Array.from(
            new Set((payload.targets ?? []).map((target) => target.familyId).filter((id): id is string => Boolean(id))),
        );
        const targetFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId: session.tenantId,
                deletedAt: null,
                id: { in: targetFamilyIds },
            },
            include: {
                versions: {
                    orderBy: { version: 'desc' },
                    take: 1,
                    select: { id: true },
                },
            },
        });
        const targetFamilyById = new Map(targetFamilies.map((family) => [family.id, family]));

        for (const recipe of recipes) {
            const target = targetByName.get(recipe.name);
            if (!target?.familyId) continue;

            const family = targetFamilyById.get(target.familyId);
            if (!family || family.name !== recipe.name) {
                throw new BadRequestException(`配方“${recipe.name}”已发生变化，请刷新工作台后重试。`);
            }
            if (family.type !== recipe.type || family.category !== recipe.category) {
                throw new BadRequestException(`配方“${recipe.name}”的类型或品类不可在电脑端修改。`);
            }
            if (!target.baseVersionId || family.versions[0]?.id !== target.baseVersionId) {
                throw new BadRequestException(`配方“${recipe.name}”已有更新版本，请刷新工作台后重新编辑。`);
            }
        }

        const newRecipeNames = recipes
            .filter((recipe) => !targetByName.get(recipe.name)?.familyId)
            .map((recipe) => recipe.name);
        const conflictingFamilies = await this.prisma.recipeFamily.findMany({
            where: {
                tenantId: session.tenantId,
                deletedAt: null,
                name: { in: newRecipeNames },
            },
            select: { name: true },
        });
        if (conflictingFamilies.length > 0) {
            throw new BadRequestException(
                `店铺中已存在同名配方：${conflictingFamilies.map((family) => family.name).join('、')}，请刷新工作台后重试。`,
            );
        }

        const result = {
            totalCount: recipes.length,
            importedCount: 0,
            skippedCount: 0,
            skippedRecipes: [] as string[],
        };
        const failedRecipeNames = new Set<string>();

        for (const recipe of recipes) {
            try {
                const createDto = this.toCreateRecipeDto(recipe);
                const target = targetByName.get(recipe.name);
                if (target?.familyId && target.baseVersionId) {
                    await this.recipesService.updateVersion(
                        session.tenantId,
                        target.familyId,
                        target.baseVersionId,
                        session.userId,
                        createDto,
                    );
                } else {
                    await this.recipesService.create(session.tenantId, session.userId, createDto);
                }
                result.importedCount++;
            } catch (error) {
                const message = error instanceof Error ? error.message : '发布失败';
                failedRecipeNames.add(recipe.name);
                result.skippedCount++;
                result.skippedRecipes.push(`${recipe.name}：${message}`);
            }
        }

        if (result.skippedCount === 0) {
            await this.prisma.recipeDraft.update({
                where: { id: draft.id },
                data: {
                    status: RecipeDraftStatus.SYNCED,
                    syncedAt: new Date(),
                },
            });
        } else if (result.importedCount > 0) {
            const remainingRecipes = recipes.filter((recipe) => failedRecipeNames.has(recipe.name));
            const remainingTargets = (payload.targets ?? []).filter((target) =>
                failedRecipeNames.has(target.recipeName),
            );
            const originalMeta = ((draft.payload as Record<string, unknown>).meta ?? {}) as Record<string, unknown>;
            const remainingReviewItems = Array.isArray(originalMeta.reviewItems)
                ? originalMeta.reviewItems.filter((item) => {
                      if (!item || typeof item !== 'object') return false;
                      const recipeName = (item as Record<string, unknown>).recipeName;
                      return typeof recipeName === 'string' && failedRecipeNames.has(recipeName);
                  })
                : undefined;
            await this.prisma.recipeDraft.update({
                where: { id: draft.id },
                data: {
                    title: `${remainingRecipes.length} 个配方待修正`,
                    payload: {
                        recipes: remainingRecipes,
                        targets: remainingTargets,
                        meta: {
                            ...originalMeta,
                            ...(remainingReviewItems ? { reviewItems: remainingReviewItems } : {}),
                        },
                    } as unknown as Prisma.InputJsonValue,
                },
            });
        }

        return result;
    }

    async closeSession(sessionId: string, token: string) {
        const session = await this.findSession(sessionId, token);
        return this.prisma.recipeEditorSession.update({
            where: { id: session.id },
            data: { status: RecipeEditorSessionStatus.EXPIRED },
            select: { id: true, status: true },
        });
    }

    private toCreateRecipeDto(recipe: BatchImportRecipeDto): CreateRecipeDto {
        const version = recipe.versions.at(-1);
        if (!version) {
            throw new BadRequestException(`配方“${recipe.name}”没有可发布的版本。`);
        }

        return {
            name: recipe.name,
            type: recipe.type,
            category: recipe.category,
            notes: version.notes,
            targetTemp: version.targetTemp,
            lossRatio: version.lossRatio,
            divisionLoss: version.divisionLoss,
            customWaterContent: version.customWaterContent,
            procedure: version.procedure,
            ingredients: version.ingredients.map((ingredient) => ({ ...ingredient })),
            products: version.products?.map((product) => ({
                name: product.name,
                weight: product.weight,
                procedure: product.procedure,
                mixIn: (product.mixIn ?? []).map((ingredient) => ({
                    ...ingredient,
                    type: ProductIngredientType.MIX_IN,
                })),
                fillings: (product.fillings ?? []).map((ingredient) => ({
                    ...ingredient,
                    type: ProductIngredientType.FILLING,
                })),
                toppings: (product.toppings ?? []).map((ingredient) => ({
                    ...ingredient,
                    type: ProductIngredientType.TOPPING,
                })),
            })),
        };
    }

    private async getDraftForSession(draftId: string, tenantId: string) {
        const draft = await this.prisma.recipeDraft.findFirst({
            where: { id: draftId, tenantId },
        });
        if (!draft) {
            throw new NotFoundException('草稿不存在');
        }
        return draft;
    }

    private async getApprovedSession(
        sessionId: string,
        token: string,
        extendLease = true,
    ): Promise<EditorSessionContext> {
        const session = await this.findSession(sessionId, token);
        if (session.status !== RecipeEditorSessionStatus.APPROVED || !session.tenantId || !session.userId) {
            throw new UnauthorizedException('编辑会话未授权或已失效');
        }
        if (session.expiresAt <= new Date()) {
            await this.prisma.recipeEditorSession.update({
                where: { id: session.id },
                data: { status: RecipeEditorSessionStatus.EXPIRED },
            });
            throw new UnauthorizedException('编辑会话已结束，请重新扫码授权');
        }
        if (!extendLease) return session as EditorSessionContext;
        const extended = await this.prisma.recipeEditorSession.update({
            where: { id: session.id },
            data: { expiresAt: this.nextLeaseExpiry() },
        });
        return extended as EditorSessionContext;
    }

    private async findSession(sessionId: string, token: string) {
        if (!sessionId || !token) {
            throw new UnauthorizedException('缺少编辑会话凭证');
        }
        const session = await this.prisma.recipeEditorSession.findFirst({
            where: { id: sessionId, token },
        });
        if (!session) {
            throw new NotFoundException('编辑会话不存在');
        }
        return session;
    }

    private nextLeaseExpiry() {
        return new Date(Date.now() + this.editorLeaseMs);
    }

    private async expireStaleTenantSessions(tx: Prisma.TransactionClient, tenantId: string, now: Date) {
        await tx.recipeEditorSession.updateMany({
            where: {
                tenantId,
                status: RecipeEditorSessionStatus.APPROVED,
                expiresAt: { lte: now },
            },
            data: { status: RecipeEditorSessionStatus.EXPIRED },
        });
    }
}
