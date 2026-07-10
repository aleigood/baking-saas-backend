import {
    BadRequestException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    OnModuleInit,
    ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, RecipeImportJobStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BatchImportRecipeDto } from '../recipes/dto/batch-import-recipe.dto';
import { RecipeImportModelProvider, RecipeImportSource } from './recipe-import.provider';
import {
    ModelImportResult,
    ModelIntermediateImportResult,
    ModelIntermediateIngredient,
    ModelIntermediateRecipe,
    RecipeImportAnalysis,
    RecipeImportIngredient,
    RecipeImportReviewItem,
    RecipeImportReviewSeverity,
} from './recipe-import.types';

export const RECIPE_IMPORT_EDITOR_CONTEXT = 'RECIPE_IMPORT_EDITOR_CONTEXT';
type RecipeImportReviewCandidate = Omit<RecipeImportReviewItem, 'id' | 'fieldId' | 'status' | 'diagnostics'>;

interface RecipeImportEditorContext {
    getEditorMe(sessionId: string, token: string): Promise<{ tenant: { id: string } | null }>;
    listIngredients(sessionId: string, token: string): Promise<{ ingredients?: Array<{ id: string; name: string }> }>;
    listRecipes(
        sessionId: string,
        token: string,
    ): Promise<{
        recipes?: Array<{ recipe: { name: string; type: string } }>;
    }>;
}

@Injectable()
export class RecipeImportService implements OnModuleInit {
    private readonly logger = new Logger(RecipeImportService.name);

    constructor(
        @Inject(RECIPE_IMPORT_EDITOR_CONTEXT) private readonly editorService: RecipeImportEditorContext,
        private readonly modelProvider: RecipeImportModelProvider,
        private readonly prisma: PrismaService,
    ) {}

    onModuleInit() {
        void this.recoverInterruptedJobs();
    }

    async createJob(sessionId: string, token: string, source: RecipeImportSource) {
        try {
            this.validateSource(source);
            await this.cleanupExpiredDiagnostics();
            const [editorMe, catalogContext] = await Promise.all([
                this.editorService.getEditorMe(sessionId, token),
                this.buildCatalogContext(sessionId, token),
            ]);
            if (!editorMe.tenant?.id) throw new BadRequestException('编辑会话未绑定店铺。');

            const reusableJob = await this.findReusableCompletedJob(editorMe.tenant.id, source);
            if (reusableJob) {
                this.logger.log(
                    `复用上一次智能导入结果 jobId=${reusableJob.id} file=${source.fileName || 'pasted-text'} provider=${this.modelProvider.providerName} model=${this.modelProvider.modelName}`,
                );
                return {
                    jobId: reusableJob.id,
                    status: reusableJob.status,
                    createdAt: reusableJob.createdAt,
                    reused: true,
                };
            }

            const job = await this.prisma.recipeImportJob.create({
                data: {
                    tenantId: editorMe.tenant.id,
                    fileName: source.fileName,
                    mimeType: source.mimeType,
                    sourceData: source.buffer,
                    sourceText: source.text,
                    catalogContext,
                },
                select: { id: true, status: true, createdAt: true },
            });
            this.scheduleJob(job.id);
            return { jobId: job.id, status: job.status, createdAt: job.createdAt };
        } catch (error) {
            this.throwIfRecipeImportStorageNotMigrated(error);
            throw error;
        }
    }

    private async findReusableCompletedJob(tenantId: string, source: RecipeImportSource) {
        if (!this.shouldReuseLastSuccessfulImport()) return null;
        const ttlMs = this.getReuseLastSuccessfulImportTtlMs();
        const since = new Date(Date.now() - ttlMs);
        const candidates = await this.prisma.recipeImportJob.findMany({
            where: {
                tenantId,
                status: RecipeImportJobStatus.COMPLETED,
                fileName: source.fileName ?? null,
                mimeType: source.mimeType ?? null,
                completedAt: { gte: since },
                result: { not: Prisma.DbNull },
            },
            select: {
                id: true,
                status: true,
                createdAt: true,
                sourceData: true,
                sourceText: true,
                result: true,
            },
            orderBy: { completedAt: 'desc' },
            take: 20,
        });
        return (
            candidates.find((job) => {
                if (!this.isSameImportSource(job, source)) return false;
                const result = job.result as { meta?: { provider?: string; model?: string } } | null;
                return (
                    result?.meta?.provider === this.modelProvider.providerName &&
                    result?.meta?.model === this.modelProvider.modelName
                );
            }) || null
        );
    }

    private shouldReuseLastSuccessfulImport() {
        return String(process.env.RECIPE_IMPORT_REUSE_LAST_SUCCESS || '').toLowerCase() === 'true';
    }

    private getReuseLastSuccessfulImportTtlMs() {
        const configured = Number(process.env.RECIPE_IMPORT_REUSE_LAST_SUCCESS_TTL_MS || 24 * 60 * 60 * 1000);
        return Number.isFinite(configured) && configured > 0 ? configured : 24 * 60 * 60 * 1000;
    }

    private isSameImportSource(
        job: { sourceData?: Uint8Array | Buffer | null; sourceText?: string | null },
        source: RecipeImportSource,
    ) {
        if (source.text != null) return (job.sourceText || '') === source.text;
        if (!source.buffer) return !job.sourceData;
        if (!job.sourceData) return false;
        return Buffer.compare(Buffer.from(job.sourceData), source.buffer) === 0;
    }

    async getJob(sessionId: string, token: string, jobId: string) {
        try {
            const editorMe = await this.editorService.getEditorMe(sessionId, token);
            const job = await this.prisma.recipeImportJob.findFirst({
                where: { id: jobId, tenantId: editorMe.tenant?.id },
                select: {
                    id: true,
                    status: true,
                    result: true,
                    errorMessage: true,
                    createdAt: true,
                    startedAt: true,
                    completedAt: true,
                },
            });
            if (!job) throw new NotFoundException('智能导入任务不存在或已失效。');
            return {
                jobId: job.id,
                status: job.status,
                result: job.status === RecipeImportJobStatus.COMPLETED ? job.result : undefined,
                errorMessage: job.status === RecipeImportJobStatus.FAILED ? job.errorMessage : undefined,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                completedAt: job.completedAt,
            };
        } catch (error) {
            this.throwIfRecipeImportStorageNotMigrated(error);
            throw error;
        }
    }

    async analyze(sessionId: string, token: string, source: RecipeImportSource): Promise<RecipeImportAnalysis> {
        this.validateSource(source);
        const catalogContext = await this.buildCatalogContext(sessionId, token);
        return this.analyzeSource(source, catalogContext);
    }

    private async buildCatalogContext(sessionId: string, token: string) {
        const [ingredientCatalog, recipeCatalog] = await Promise.all([
            this.editorService.listIngredients(sessionId, token),
            this.editorService.listRecipes(sessionId, token),
        ]);
        const ingredients = (ingredientCatalog.ingredients ?? [])
            .slice(0, 500)
            .map((item) => ({ id: item.id, name: item.name }));
        const recipes = (recipeCatalog.recipes ?? [])
            .slice(0, 200)
            .map((item) => `${item.recipe.name}(${item.recipe.type})`);
        return JSON.stringify({ ingredients, recipes });
    }

    private async analyzeSource(source: RecipeImportSource, catalogContext: string): Promise<RecipeImportAnalysis> {
        const traceId = randomUUID().slice(0, 8);
        const startedAt = Date.now();
        this.logger.log(
            `配方识别开始 traceId=${traceId} file=${source.fileName || 'pasted-text'} mime=${source.mimeType || 'text/plain'} size=${source.buffer?.length || source.text?.length || 0} provider=${this.modelProvider.providerName} model=${this.modelProvider.modelName}`,
        );
        let modelResult;
        try {
            modelResult = await this.modelProvider.analyze(source, catalogContext);
            this.logger.log(`配方识别完成 traceId=${traceId} durationMs=${Date.now() - startedAt}`);
        } catch (error) {
            this.logger.error(
                `配方识别失败 traceId=${traceId} durationMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : 'unknown'}`,
            );
            throw error;
        }
        const convertedResult = this.convertModelResult(modelResult);
        const normalizedRecipes = this.normalizeRecipes(convertedResult.recipes);
        const ingredients = this.normalizeIngredients(normalizedRecipes, catalogContext, convertedResult.reviewItems ?? []);
        const reviewItems = this.buildReviewItems(normalizedRecipes, convertedResult.reviewItems ?? []);
        const counts = (severity: RecipeImportReviewItem['severity']) =>
            reviewItems.filter((item) => item.severity === severity && item.status === 'PENDING').length;
        return {
            recipes: normalizedRecipes,
            reviewItems,
            ingredients,
            summary: {
                recipeCount: normalizedRecipes.length,
                blockingCount: counts('BLOCKING'),
                reviewCount: counts('REVIEW'),
                infoCount: counts('INFO'),
            },
            meta: {
                source: 'ai-import',
                provider: this.modelProvider.providerName,
                model: this.modelProvider.modelName,
                fileName: source.fileName,
                analyzedAt: new Date().toISOString(),
            },
            diagnostics: {
                ...modelResult.diagnostics,
                intermediateResult: convertedResult.intermediateResult,
            },
        };
    }

    private validateSource(source: RecipeImportSource) {
        if (!source.buffer && !source.text?.trim()) throw new BadRequestException('请选择配方文件或粘贴配方内容。');
        if (source.buffer && source.buffer.length > 15 * 1024 * 1024)
            throw new BadRequestException('单个文件不能超过 15MB。');
        if (source.fileName && !/\.(xlsx?|csv|jpe?g|png|webp|pdf|txt)$/i.test(source.fileName))
            throw new BadRequestException('暂不支持该文件格式，请上传 Excel、CSV、图片、PDF 或文本文件。');
    }

    private scheduleJob(jobId: string) {
        setImmediate(() => void this.processJob(jobId));
    }

    private async recoverInterruptedJobs() {
        try {
            await this.cleanupExpiredDiagnostics();
            await this.prisma.recipeImportJob.updateMany({
                where: { status: RecipeImportJobStatus.PROCESSING },
                data: { status: RecipeImportJobStatus.PENDING, startedAt: null },
            });
            const pendingJobs = await this.prisma.recipeImportJob.findMany({
                where: { status: RecipeImportJobStatus.PENDING },
                select: { id: true },
                orderBy: { createdAt: 'asc' },
                take: 20,
            });
            pendingJobs.forEach((job) => this.scheduleJob(job.id));
        } catch (error) {
            if (this.isRecipeImportStorageNotMigrated(error)) {
                this.logger.warn(
                    '智能导入任务表或字段不存在，已跳过启动恢复。请执行数据库迁移以启用异步智能导入：npm run prisma:migrate:deploy 或 npx prisma migrate deploy。',
                );
                return;
            }
            this.logger.error(
                `智能导入任务恢复失败：${error instanceof Error ? error.message : 'unknown error'}`,
            );
        }
    }

    private async cleanupExpiredDiagnostics() {
        try {
            await this.prisma.recipeImportJob.updateMany({
                where: { diagnosticExpiresAt: { lt: new Date() } },
                data: { sourceData: null, sourceText: null, diagnosticData: Prisma.DbNull, diagnosticExpiresAt: null },
            });
        } catch (error) {
            if (this.isRecipeImportStorageNotMigrated(error)) return;
            throw error;
        }
    }

    private isRecipeImportStorageNotMigrated(error: unknown) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
        const table = String(error.meta?.table || '');
        const column = String(error.meta?.column || '');
        return (
            (error.code === 'P2021' && table.includes('RecipeImportJob')) ||
            (error.code === 'P2022' && (table.includes('RecipeImportJob') || column.includes('RecipeImportJob')))
        );
    }

    private throwIfRecipeImportStorageNotMigrated(error: unknown): never | void {
        if (!this.isRecipeImportStorageNotMigrated(error)) return;
        throw new ServiceUnavailableException(
            '智能导入任务表或字段不存在，请先在当前数据库执行迁移后再使用智能导入。需要应用迁移：20260708090000_add_recipe_import_jobs 和 20260708120000_add_recipe_import_diagnostics。',
        );
    }

    private async processJob(jobId: string) {
        const claimed = await this.prisma.recipeImportJob.updateMany({
            where: { id: jobId, status: RecipeImportJobStatus.PENDING },
            data: { status: RecipeImportJobStatus.PROCESSING, startedAt: new Date(), errorMessage: null },
        });
        if (claimed.count !== 1) return;

        const job = await this.prisma.recipeImportJob.findUnique({ where: { id: jobId } });
        if (!job) return;
        try {
            const result = await this.analyzeSource(
                {
                    fileName: job.fileName ?? undefined,
                    mimeType: job.mimeType ?? undefined,
                    buffer: job.sourceData ? Buffer.from(job.sourceData) : undefined,
                    text: job.sourceText ?? undefined,
                },
                job.catalogContext,
            );
            const { diagnostics, ...publicResult } = result;
            await this.updateJobCompleted(job.id, publicResult, diagnostics || {});
        } catch (error) {
            const message = error instanceof Error ? error.message : '智能识别失败';
            const diagnostics =
                typeof error === 'object' && error !== null && 'diagnostics' in error
                    ? (error as { diagnostics: Record<string, unknown> }).diagnostics
                    : {};
            this.logger.error(`异步配方识别失败 jobId=${job.id} error=${message}`);
            await this.updateJobFailed(job.id, message, diagnostics);
        }
    }

    private async updateJobCompleted(
        jobId: string,
        result: Omit<RecipeImportAnalysis, 'diagnostics'>,
        diagnostics: Record<string, unknown>,
    ) {
        try {
            await this.prisma.recipeImportJob.update({
                where: { id: jobId },
                data: {
                    status: RecipeImportJobStatus.COMPLETED,
                    result: result as unknown as Prisma.InputJsonValue,
                    completedAt: new Date(),
                    diagnosticData: diagnostics as Prisma.InputJsonValue,
                    diagnosticExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            });
        } catch (error) {
            if (!this.isRecipeImportStorageNotMigrated(error)) throw error;
            this.logger.warn('智能导入诊断字段未迁移，任务结果将保存但不保留诊断包。');
            await this.prisma.recipeImportJob.update({
                where: { id: jobId },
                data: {
                    status: RecipeImportJobStatus.COMPLETED,
                    result: result as unknown as Prisma.InputJsonValue,
                    completedAt: new Date(),
                },
            });
        }
    }

    private async updateJobFailed(jobId: string, message: string, diagnostics: Record<string, unknown>) {
        try {
            await this.prisma.recipeImportJob.update({
                where: { id: jobId },
                data: {
                    status: RecipeImportJobStatus.FAILED,
                    errorMessage: message.slice(0, 2000),
                    completedAt: new Date(),
                    diagnosticData: diagnostics as Prisma.InputJsonValue,
                    diagnosticExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            });
        } catch (error) {
            if (!this.isRecipeImportStorageNotMigrated(error)) throw error;
            this.logger.warn('智能导入诊断字段未迁移，失败状态将保存但不保留诊断包。');
            await this.prisma.recipeImportJob.update({
                where: { id: jobId },
                data: {
                    status: RecipeImportJobStatus.FAILED,
                    errorMessage: message.slice(0, 2000),
                    completedAt: new Date(),
                },
            });
        }
    }

    private convertModelResult(modelResult: ModelImportResult): {
        recipes: BatchImportRecipeDto[];
        reviewItems: RecipeImportReviewCandidate[];
        intermediateResult?: ModelIntermediateImportResult;
    } {
        if (Array.isArray(modelResult.intermediateRecipes)) {
            const convertedReviewItems: RecipeImportReviewCandidate[] = [
                ...(modelResult.reviewItems ?? []),
            ];
            const recipes = modelResult.intermediateRecipes
                .flatMap((recipe, recipeIndex) => this.convertIntermediateRecipeBundle(recipe, recipeIndex, convertedReviewItems))
                .filter((recipe): recipe is BatchImportRecipeDto => Boolean(recipe));
            return {
                recipes,
                reviewItems: convertedReviewItems,
                intermediateResult: {
                    intermediateRecipes: modelResult.intermediateRecipes,
                    reviewItems: modelResult.reviewItems,
                },
            };
        }
        return {
            recipes: (modelResult.recipes ?? []) as BatchImportRecipeDto[],
            reviewItems: modelResult.reviewItems ?? [],
        };
    }

    private convertIntermediateRecipeBundle(
        recipe: ModelIntermediateRecipe,
        recipeIndex: number,
        reviewItems: RecipeImportReviewCandidate[],
    ): Array<BatchImportRecipeDto | null> {
        const primary = this.convertIntermediateRecipe(recipe, recipeIndex, reviewItems);
        const secondary = this.convertIntermediateSecondaryRecipes(recipe, recipeIndex, reviewItems);
        return [primary, ...secondary];
    }

    private convertIntermediateRecipe(
        recipe: ModelIntermediateRecipe,
        recipeIndex: number,
        reviewItems: RecipeImportReviewCandidate[],
    ): BatchImportRecipeDto | null {
        const name = (recipe.sourceName || recipe.suggestedName || '').trim();
        if (!name) {
            reviewItems.push({
                recipeName: '待命名配方',
                fieldPath: `intermediateRecipes.${recipeIndex}.sourceName`,
                label: '配方名称',
                severity: 'BLOCKING',
                reason: '模型未识别到配方名称',
            });
            return null;
        }

        const baseSections = (recipe.sections ?? []).filter((section) => {
            if (section.kind === 'NOTE') return false;
            if (recipe.type !== 'MAIN') return true;
            return !['FILLING', 'TOPPING', 'MIX_IN', 'EXTRA'].includes(String(section.kind || ''));
        });
        const items = baseSections
            .flatMap((section) => section.items ?? [])
            .filter((item) => item.rawName?.trim());
        if (items.length === 0) {
            reviewItems.push({
                recipeName: name,
                fieldPath: `recipes.${recipeIndex}.versions.0.ingredients`,
                label: '空配方',
                severity: 'REVIEW',
                reason: '检测到配方标题但没有原料，已跳过导入。',
            });
            return null;
        }

        const basis = this.findIntermediateBasis(recipe, items, reviewItems, recipeIndex);
        const mappedIngredients = items.map((item, ingredientIndex) => {
            const parsed = this.parseIntermediateAmount(item);
            const normalizedName = item.normalizedName?.trim() || item.rawName.trim();
            const ratio = basis > 0 && parsed.grams != null ? this.roundRatio(parsed.grams / basis) : null;
            if (
                item.normalizedName?.trim() &&
                item.normalizedName.trim() !== item.rawName.trim() &&
                !this.isDeterministicIngredientAlias(item.rawName, normalizedName)
            ) {
                reviewItems.push({
                    recipeName: name,
                    fieldPath: `recipes.${recipeIndex}.versions.0.ingredients.${ingredientIndex}.name`,
                    label: '原料名称',
                    severity: 'REVIEW',
                    recognizedValue: item.rawName,
                    normalizedValue: normalizedName,
                    reason: '模型建议将原始原料名称映射为系统规范名称，请人工确认。',
                    confidence: 0.8,
                });
            }
            if (ratio == null) {
                reviewItems.push({
                    recipeName: name,
                    fieldPath: `recipes.${recipeIndex}.versions.0.ingredients.${ingredientIndex}.ratio`,
                    label: `${normalizedName}用量`,
                    severity: recipe.type === 'MAIN' ? 'REVIEW' : 'INFO',
                    recognizedValue: parsed.sourceValue,
                    normalizedValue: null,
                    reason: parsed.reason || '原始用量不是可直接换算的克重，已保留为待确认项。',
                });
            }
            return {
                name: normalizedName,
                ratio: ratio ?? undefined,
                flourRatio: undefined,
                isFlour: this.isFlourIngredient(item),
                waterContent: item.waterContent ?? undefined,
                recipeVersionId: undefined,
                importMeta: {
                    fieldPath: `recipes.${recipeIndex}.versions.0.ingredients.${ingredientIndex}`,
                    fieldIds: {
                        name: this.reviewFieldId(
                            name,
                            `recipes.${recipeIndex}.versions.0.ingredients.${ingredientIndex}.name`,
                            '原料名称',
                        ),
                        ratio: this.reviewFieldId(
                            name,
                            `recipes.${recipeIndex}.versions.0.ingredients.${ingredientIndex}.ratio`,
                            `${normalizedName}用量`,
                        ),
                    },
                    sourceName: item.rawName,
                    sourceValue: parsed.sourceValue,
                    unit: parsed.unit,
                    grams: parsed.grams,
                    evidence: item.evidence,
                    note: item.note,
                },
            };
        });

        const ingredients = this.mergeDuplicateIngredients(mappedIngredients);
        const products = this.convertIntermediateProducts(recipe, name, reviewItems, recipeIndex);
        return {
            name,
            type: recipe.type || 'EXTRA',
            category: recipe.category || 'OTHER',
            versions: [
                {
                    notes: recipe.notes?.trim() || `智能导入${recipe.evidence ? `；证据：${recipe.evidence}` : ''}`,
                    ingredients,
                    products,
                    procedure: recipe.procedure ?? [],
                },
            ],
        } as BatchImportRecipeDto;
    }

    private convertIntermediateSecondaryRecipes(
        recipe: ModelIntermediateRecipe,
        recipeIndex: number,
        reviewItems: RecipeImportReviewCandidate[],
    ): BatchImportRecipeDto[] {
        if (recipe.type !== 'MAIN') return [];
        return (recipe.sections ?? [])
            .filter((section) => ['FILLING', 'TOPPING', 'EXTRA'].includes(String(section.kind || '')))
            .filter((section) => section.name?.trim() && section.items?.length)
            .map((section, sectionIndex) => {
                const secondary: ModelIntermediateRecipe = {
                    sourceName: section.name?.trim() || `${recipe.sourceName}-附加项`,
                    suggestedName: null,
                    type: 'EXTRA',
                    category: 'OTHER',
                    notes: `${recipe.sourceName} 中识别出的${section.kind === 'TOPPING' ? '装饰/酥粒' : '馅料/附加项'}`,
                    yieldText: null,
                    sections: [
                        {
                            name: section.name,
                            kind: 'EXTRA',
                            items: section.items,
                            evidence: section.evidence,
                        },
                    ],
                    products: [],
                    procedure: [],
                    evidence: section.evidence || recipe.evidence,
                };
                return this.convertIntermediateRecipe(secondary, Number(`${recipeIndex}${sectionIndex}`), reviewItems);
            })
            .filter((item): item is BatchImportRecipeDto => Boolean(item));
    }

    private findIntermediateBasis(
        recipe: ModelIntermediateRecipe,
        items: ModelIntermediateIngredient[],
        reviewItems: RecipeImportReviewCandidate[],
        recipeIndex: number,
    ) {
        const parsed = items.map((item) => ({ item, amount: this.parseIntermediateAmount(item) }));
        const positiveGramItems = parsed.filter((entry) => entry.amount.grams != null && entry.amount.grams > 0);
        if (recipe.type === 'MAIN' || recipe.type === 'PRE_DOUGH') {
            const flourTotal = positiveGramItems
                .filter((entry) => this.isFlourIngredient(entry.item))
                .reduce((sum, entry) => sum + (entry.amount.grams ?? 0), 0);
            if (flourTotal > 0) return flourTotal;
            reviewItems.push({
                recipeName: recipe.sourceName,
                fieldPath: `recipes.${recipeIndex}.versions.0.ingredients`,
                label: '面粉基准',
                severity: 'REVIEW',
                reason: '主面团/面种没有识别到明确粉类，系统无法按总粉量计算烘焙百分比。',
            });
            return positiveGramItems[0]?.amount.grams ?? 0;
        }
        return positiveGramItems[0]?.amount.grams ?? 0;
    }

    private convertIntermediateProducts(
        recipe: ModelIntermediateRecipe,
        recipeName: string,
        reviewItems: RecipeImportReviewCandidate[],
        recipeIndex: number,
    ) {
        const mixInSections =
            recipe.type === 'MAIN'
                ? (recipe.sections ?? []).filter((section) => section.kind === 'MIX_IN' && section.name?.trim())
                : [];
        const secondarySectionNames = new Set(
            (recipe.sections ?? [])
                .filter((section) => ['FILLING', 'TOPPING', 'EXTRA'].includes(String(section.kind || '')))
                .map((section) => section.name?.trim())
                .filter(Boolean),
        );
        const products = mixInSections.length
            ? mixInSections.map((section) => ({
                  name: section.name,
                  sourceText: recipe.yieldText,
                  mixIn: section.items,
                  fillings: [],
                  toppings: [],
                  procedure: [],
                  evidence: section.evidence,
              }))
            : recipe.products?.length
              ? recipe.products.filter((product) => !secondarySectionNames.has(product.name?.trim()))
            : recipe.yieldText
              ? [
                    {
                        name: recipe.type === 'MAIN' ? recipeName : undefined,
                        sourceText: recipe.yieldText,
                    },
                ]
              : [];
        const converted = products
            .map((product, productIndex) => {
                const parsedYield = this.parseYieldText(product.sourceText || recipe.yieldText || '');
                const weight = product.unitWeight ?? parsedYield.unitWeight;
                if (weight == null || weight <= 0) {
                    if (product.sourceText || recipe.yieldText) {
                        reviewItems.push({
                            recipeName,
                            fieldPath: `recipes.${recipeIndex}.versions.0.products.${productIndex}.weight`,
                            label: '出品规格',
                            severity: 'INFO',
                            recognizedValue: product.sourceText || recipe.yieldText,
                            normalizedValue: null,
                            reason: '识别到出品说明，但未能解析为单个克重。',
                        });
                    }
                    return null;
                }
                const convertProductIngredients = (items: ModelIntermediateIngredient[] | undefined) =>
                    (items ?? [])
                        .map((item) => {
                            const amount = this.parseIntermediateAmount(item);
                            return {
                                name: item.normalizedName?.trim() || item.rawName.trim(),
                                weightInGrams: amount.grams ?? undefined,
                            };
                        })
                        .filter((item) => item.name);
                return {
                    name: product.name?.trim() || recipeName,
                    weight,
                    mixIn: convertProductIngredients(product.mixIn),
                    fillings: convertProductIngredients(product.fillings),
                    toppings: convertProductIngredients(product.toppings),
                    procedure: product.procedure ?? [],
                    importMeta: {
                        sourceText: product.sourceText || recipe.yieldText,
                        yieldCount: product.yieldCount ?? parsedYield.yieldCount,
                        totalWeight: product.totalWeight ?? parsedYield.totalWeight,
                    },
                };
            })
            .filter((product): product is NonNullable<typeof product> => Boolean(product));
        return converted.length ? converted : undefined;
    }

    private parseIntermediateAmount(item: ModelIntermediateIngredient): {
        sourceValue: string;
        grams?: number;
        unit?: string;
        reason?: string;
    } {
        const sourceValue = String(item.rawAmount ?? item.amount ?? '').trim();
        const unit = item.unit?.trim();
        if (typeof item.amount === 'number' && Number.isFinite(item.amount)) {
            const normalizedUnit = unit || this.extractUnit(sourceValue) || 'g';
            if (this.isGramUnit(normalizedUnit)) return { sourceValue: sourceValue || String(item.amount), grams: item.amount, unit: normalizedUnit };
            return { sourceValue: sourceValue || String(item.amount), unit: normalizedUnit, reason: `单位 ${normalizedUnit} 不能自动换算为克。` };
        }
        const match = sourceValue.match(/(-?\d+(?:\.\d+)?)/);
        if (!match) return { sourceValue, unit, reason: sourceValue ? '未识别到数字用量。' : '缺少原始用量。' };
        const value = Number(match[1]);
        if (!Number.isFinite(value)) return { sourceValue, unit, reason: '用量数字无效。' };
        const normalizedUnit = unit || this.extractUnit(sourceValue) || 'g';
        if (this.isGramUnit(normalizedUnit)) return { sourceValue, grams: value, unit: normalizedUnit };
        return { sourceValue, unit: normalizedUnit, reason: `单位 ${normalizedUnit} 不能自动换算为克。` };
    }

    private parseYieldText(text: string): { unitWeight?: number; yieldCount?: number; totalWeight?: number } {
        const unitWeight = text.match(/(\d+(?:\.\d+)?)\s*g\s*\/\s*个/i)?.[1];
        const totalWeight = text.match(/总重\s*(\d+(?:\.\d+)?)\s*g?/i)?.[1];
        const yieldCount =
            text.match(/[（(]\s*(\d+(?:\.\d+)?)\s*个\s*[）)]/)?.[1] ||
            text.match(/均分\s*(\d+(?:\.\d+)?)\s*个/)?.[1];
        return {
            unitWeight: unitWeight ? Number(unitWeight) : undefined,
            yieldCount: yieldCount ? Number(yieldCount) : undefined,
            totalWeight: totalWeight ? Number(totalWeight) : undefined,
        };
    }

    private extractUnit(value: string) {
        const unit = value.match(/-?\d+(?:\.\d+)?\s*([a-zA-Z\u4e00-\u9fa5]+)/)?.[1];
        return unit?.trim();
    }

    private isGramUnit(unit?: string) {
        if (!unit) return true;
        return ['g', '克', '克重'].includes(unit.toLocaleLowerCase('zh-CN'));
    }

    private isFlourIngredient(item: ModelIntermediateIngredient) {
        if (typeof item.isFlour === 'boolean') return item.isFlour;
        const name = `${item.normalizedName || ''}${item.rawName || ''}`;
        return /(粉|面粉|高粉|低粉|t\d+|T\d+|柔风|百合花|预拌粉)/.test(name);
    }

    private roundRatio(value: number) {
        return Math.round(value * 10000) / 10000;
    }

    private mergeDuplicateIngredients<T extends { name: string; ratio?: number; flourRatio?: number; importMeta?: Record<string, unknown> }>(
        ingredients: T[],
    ): T[] {
        const merged = new Map<string, T>();
        ingredients.forEach((ingredient) => {
            const key = this.ingredientKey(ingredient.name);
            const existing = merged.get(key);
            if (!existing) {
                merged.set(key, ingredient);
                return;
            }
            existing.ratio = this.addOptionalRatios(existing.ratio, ingredient.ratio);
            existing.flourRatio = this.addOptionalRatios(existing.flourRatio, ingredient.flourRatio);
            existing.importMeta = this.mergeIngredientImportMeta(existing.importMeta, ingredient.importMeta);
        });
        return Array.from(merged.values());
    }

    private addOptionalRatios(left?: number, right?: number) {
        if (left == null) return right;
        if (right == null) return left;
        return this.roundRatio(left + right);
    }

    private mergeIngredientImportMeta(
        left?: Record<string, unknown>,
        right?: Record<string, unknown>,
    ): Record<string, unknown> | undefined {
        if (!left) return right;
        if (!right) return left;
        const mergeText = (a: unknown, b: unknown) => {
            const values = [a, b]
                .map((value) => (value == null ? '' : String(value).trim()))
                .filter(Boolean);
            return Array.from(new Set(values)).join(' + ');
        };
        const grams =
            typeof left.grams === 'number' && typeof right.grams === 'number'
                ? left.grams + right.grams
                : (left.grams ?? right.grams);
        return {
            ...left,
            sourceName: mergeText(left.sourceName, right.sourceName) || left.sourceName,
            sourceValue: mergeText(left.sourceValue, right.sourceValue) || left.sourceValue,
            evidence: mergeText(left.evidence, right.evidence) || left.evidence,
            note: mergeText(left.note, right.note) || left.note,
            grams,
        };
    }

    private isDeterministicIngredientAlias(rawName: string, normalizedName: string) {
        const rawKey = this.ingredientKey(rawName);
        const normalizedKey = this.ingredientKey(normalizedName);
        const waterAliases = new Set(['水', '后加水', '冰水', '温水', '纯净水', '饮用水']);
        if (normalizedKey === this.ingredientKey('水') && waterAliases.has(rawKey)) return true;
        const semiDryYeastAliases = new Set(['低糖干酵母', '低糖酵母', '低糖干性酵母']);
        if (normalizedKey === this.ingredientKey('半干酵母') && semiDryYeastAliases.has(rawKey)) return true;
        return false;
    }

    private normalizeRecipes(recipes: BatchImportRecipeDto[]) {
        if (!Array.isArray(recipes) || recipes.length === 0) throw new BadRequestException('没有从文件中识别到配方。');
        return recipes.map((recipe) => ({
            ...recipe,
            name: recipe.name?.trim() || '待命名配方',
            category: recipe.category || 'OTHER',
            versions: (recipe.versions ?? []).map((version) => ({
                ...version,
                notes: version.notes?.trim() || '智能导入',
                lossRatio: this.normalizeLossRatio(version.lossRatio),
                ingredients: (version.ingredients ?? []).map((ingredient) => ({
                    ...ingredient,
                    name: ingredient.name?.trim() || '待确认原料',
                    ratio: this.normalizeRatio(ingredient.ratio),
                    flourRatio: this.normalizeRatio(ingredient.flourRatio),
                })),
                products: version.products?.map((product) => ({
                    ...product,
                    mixIn: product.mixIn?.map((ingredient) => ({
                        ...ingredient,
                        ratio: this.normalizeRatio(ingredient.ratio),
                    })),
                    fillings: product.fillings?.map((ingredient) => ({
                        ...ingredient,
                        ratio: this.normalizeRatio(ingredient.ratio),
                    })),
                    toppings: product.toppings?.map((ingredient) => ({
                        ...ingredient,
                        ratio: this.normalizeRatio(ingredient.ratio),
                    })),
                })).map((product, _index, products) => ({
                    ...product,
                    name:
                        recipe.type === 'MAIN' &&
                        products.length === 1 &&
                        !product.mixIn?.length &&
                        !product.fillings?.length &&
                        !product.toppings?.length
                            ? recipe.name?.trim() || product.name
                            : product.name,
                })),
            })),
        }));
    }

    private normalizeIngredients(
        recipes: BatchImportRecipeDto[],
        catalogContext: string,
        modelReviewItems: Array<{ label: string; recognizedValue?: string | number | null; normalizedValue?: string | number | null }>,
    ): RecipeImportIngredient[] {
        const catalog = this.parseIngredientCatalog(catalogContext);
        const exactByName = new Map(catalog.map((item) => [this.ingredientKey(item.name), item]));
        const recognizedByNormalized = new Map(
            modelReviewItems
                .filter(
                    (item) =>
                        item.label?.includes('原料') &&
                        typeof item.recognizedValue === 'string' &&
                        typeof item.normalizedValue === 'string' &&
                        !this.isDeterministicIngredientAlias(item.recognizedValue, item.normalizedValue),
                )
                .map((item) => [this.ingredientKey(String(item.normalizedValue)), String(item.recognizedValue)]),
        );
        const collected = new Map<string, RecipeImportIngredient>();
        const collect = (name: string | undefined, usage: string) => {
            const parsedName = name?.trim() || '待确认原料';
            const match = exactByName.get(this.ingredientKey(parsedName));
            const normalizedName = match?.name || parsedName;
            const sourceName = recognizedByNormalized.get(this.ingredientKey(normalizedName)) || parsedName;
            const key = this.ingredientKey(sourceName);
            const existing = collected.get(key);
            if (existing) {
                existing.occurrenceCount++;
                if (!existing.usages.includes(usage)) existing.usages.push(usage);
                return match?.name;
            }
            collected.set(key, {
                sourceName,
                normalizedName,
                ingredientId: match?.id,
                status: sourceName !== normalizedName ? 'REVIEW' : match ? 'MATCHED' : 'NEW',
                usages: [usage],
                occurrenceCount: 1,
            });
            return match?.name;
        };

        recipes.forEach((recipe) =>
            recipe.versions?.forEach((version) => {
                version.ingredients?.forEach((ingredient) => {
                    ingredient.name = collect(ingredient.name, `${recipe.name} / 配方原料`) || ingredient.name;
                });
                version.products?.forEach((product) => {
                    const visit = (items: Array<{ name: string }> | undefined, section: string) =>
                        items?.forEach((ingredient) => {
                            ingredient.name = collect(ingredient.name, `${recipe.name} / ${product.name} / ${section}`) || ingredient.name;
                        });
                    visit(product.mixIn, '混入');
                    visit(product.fillings, '馅料');
                    visit(product.toppings, '装饰');
                });
            }),
        );
        return Array.from(collected.values());
    }

    private parseIngredientCatalog(catalogContext: string): Array<{ id: string; name: string }> {
        try {
            const parsed = JSON.parse(catalogContext) as { ingredients?: Array<{ id: string; name: string }> };
            return Array.isArray(parsed.ingredients) ? parsed.ingredients : [];
        } catch {
            return [];
        }
    }

    private ingredientKey(name: string) {
        return name.normalize('NFKC').trim().replace(/[\s·・_-]+/g, '').toLocaleLowerCase('zh-CN');
    }

    private normalizeRatio(value?: number) {
        if (value == null || !Number.isFinite(value)) return value;
        return Math.abs(value) > 3 ? value / 100 : value;
    }

    private normalizeLossRatio(value?: number) {
        if (value == null || !Number.isFinite(value)) return value;
        return Math.abs(value) > 0.2 ? value / 100 : value;
    }

    private buildReviewItems(
        recipes: BatchImportRecipeDto[],
        modelItems: RecipeImportReviewCandidate[],
    ) {
        const items: RecipeImportReviewItem[] = modelItems
            .filter((item) => {
                if (this.isIngredientIdentityReview(item)) return false;
                if (
                    typeof item.recognizedValue !== 'string' ||
                    typeof item.normalizedValue !== 'string' ||
                    !item.label?.includes('原料')
                )
                    return true;
                return !this.isDeterministicIngredientAlias(item.recognizedValue, item.normalizedValue);
            })
            .map((item) => ({
                ...item,
                id: randomUUID(),
                fieldId: this.reviewFieldId(item.recipeName, item.fieldPath, item.label),
                status: 'PENDING',
                diagnostics: [this.toReviewDiagnostic(item)],
            }));
        recipes.forEach((recipe, recipeIndex) => {
            if (!recipe.name || recipe.name === '待命名配方')
                items.push(
                    this.blocking(recipe.name, `recipes.${recipeIndex}.name`, '配方名称', '未识别到明确的配方名称'),
                );
            if (!recipe.versions?.length)
                items.push(
                    this.blocking(recipe.name, `recipes.${recipeIndex}.versions`, '配方版本', '配方中没有可用版本'),
                );
            recipe.versions?.forEach((version, versionIndex) => {
                if (!version.ingredients?.length)
                    items.push(
                        this.blocking(
                            recipe.name,
                            `recipes.${recipeIndex}.versions.${versionIndex}.ingredients`,
                            '原料列表',
                            '没有识别到原料',
                        ),
                    );
                version.ingredients?.forEach((ingredient, ingredientIndex) => {
                    const importMeta = ingredient as typeof ingredient & { importMeta?: { sourceValue?: string } };
                    if (
                        ingredient.ratio == null &&
                        ingredient.flourRatio == null &&
                        !importMeta.importMeta?.sourceValue
                    )
                        items.push(
                            this.blocking(
                                recipe.name,
                                `recipes.${recipeIndex}.versions.${versionIndex}.ingredients.${ingredientIndex}.ratio`,
                                `${ingredient.name}用量`,
                                '未识别到可计算的比例或克重',
                            ),
                        );
                });
            });
        });
        return this.aggregateReviewItems(items);
    }

    private isIngredientIdentityReview(item: RecipeImportReviewCandidate) {
        const text = `${item.label || ''}${item.reason || ''}`;
        if (/缺失|列表|用量|比例|克重|重量|规格/.test(text)) return false;
        const fieldPath = String(item.fieldPath || '');
        return (
            /未标准化|已标准化为/.test(text) ||
            /未知原料|面粉名称/.test(text) ||
            /\.ingredients\.\d+\.name$/.test(fieldPath) ||
            /\.mixIn\.\d+\.name$/.test(fieldPath) ||
            /\.mixIns\.\d+\.name$/.test(fieldPath) ||
            /\.fillings\.\d+\.name$/.test(fieldPath) ||
            /\.toppings\.\d+\.name$/.test(fieldPath) ||
            (/原料/.test(text) && /名称|确认|统一|规范|映射|未知/.test(text)) ||
            (/面粉/.test(text) && /名称|确认|统一|规范|映射/.test(text))
        );
    }

    private blocking(recipeName: string, fieldPath: string, label: string, reason: string): RecipeImportReviewItem {
        const source = { recipeName, fieldPath, label, severity: 'BLOCKING' as const, reason };
        return {
            ...source,
            id: randomUUID(),
            fieldId: this.reviewFieldId(recipeName, fieldPath, label),
            status: 'PENDING',
            diagnostics: [this.toReviewDiagnostic(source)],
        };
    }

    private reviewFieldId(recipeName: string, fieldPath: string, label: string) {
        const canonicalPath = String(fieldPath || '').replace(/\.(amount|weight|weightInGrams)$/, '.ratio');
        const key = /用量$/.test(String(label || '').trim())
            ? `${recipeName}::amount::${String(label).trim()}`
            : `${recipeName}::${canonicalPath || label}`;
        return `recipe-import-field:${key}`;
    }

    private toReviewDiagnostic(item: RecipeImportReviewCandidate) {
        return {
            label: item.label,
            reason: item.reason,
            recognizedValue: item.recognizedValue,
            normalizedValue: item.normalizedValue,
            derivation: item.derivation,
            confidence: item.confidence,
        };
    }

    private aggregateReviewItems(items: RecipeImportReviewItem[]) {
        const severityRank: Record<RecipeImportReviewSeverity, number> = { INFO: 1, REVIEW: 2, BLOCKING: 3 };
        const grouped = new Map<string, RecipeImportReviewItem>();
        items.forEach((item) => {
            const existing = grouped.get(item.fieldId);
            if (!existing) {
                grouped.set(item.fieldId, { ...item, diagnostics: [...item.diagnostics] });
                return;
            }
            if (severityRank[item.severity] > severityRank[existing.severity]) existing.severity = item.severity;
            if (!existing.fieldPath.startsWith('recipes.') && item.fieldPath.startsWith('recipes.')) {
                existing.fieldPath = item.fieldPath;
            }
            item.diagnostics.forEach((diagnostic) => {
                if (!existing.diagnostics.some((entry) => entry.reason === diagnostic.reason)) {
                    existing.diagnostics.push(diagnostic);
                }
            });
            existing.reason = existing.diagnostics.map((diagnostic) => diagnostic.reason).join('；');
            existing.recognizedValue ??= item.recognizedValue;
            existing.normalizedValue ??= item.normalizedValue;
        });
        return Array.from(grouped.values());
    }
}
