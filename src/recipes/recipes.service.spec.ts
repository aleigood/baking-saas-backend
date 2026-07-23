import { BadRequestException } from '@nestjs/common';
import { ProductIngredientType, RecipeCategory, RecipeType } from '@prisma/client';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';

type DependencyResolver = {
    resolveActiveDependencyVersions(tenantId: string, recipe: CreateRecipeDto): Promise<CreateRecipeDto>;
};

describe('RecipesService dependency resolution', () => {
    const findMany = jest.fn();
    const service = new RecipesService({ recipeFamily: { findMany } } as never, {} as never);
    const resolveDependencies = (recipe: CreateRecipeDto) =>
        (service as unknown as DependencyResolver).resolveActiveDependencyVersions('tenant-1', recipe);

    beforeEach(() => {
        findMany.mockReset();
    });

    it('replaces client version ids with the current active versions', async () => {
        findMany.mockResolvedValue([
            { id: 'pre-family', name: '波兰种', type: RecipeType.PRE_DOUGH, versions: [{ id: 'pre-active' }] },
            { id: 'extra-family', name: '奶酥', type: RecipeType.EXTRA, versions: [{ id: 'extra-active' }] },
        ]);

        const result = await resolveDependencies({
            name: '吐司',
            type: RecipeType.MAIN,
            category: RecipeCategory.BREAD,
            ingredients: [
                { name: '波兰种', flourRatio: 0.2, recipeVersionId: 'pre-old' },
                { name: '奶酥', ratio: 0.1, recipeVersionId: 'extra-old' },
            ],
            products: [
                {
                    name: '吐司',
                    weight: 450,
                    mixIn: [
                        {
                            name: '奶酥',
                            type: ProductIngredientType.MIX_IN,
                            ratio: 0.1,
                            recipeVersionId: 'extra-old',
                        },
                    ],
                },
            ],
        });

        expect(result.ingredients.map((ingredient) => ingredient.recipeVersionId)).toEqual([
            'pre-active',
            'extra-active',
        ]);
        expect(result.products?.[0].mixIn?.[0].recipeVersionId).toBe('extra-active');
    });

    it('rejects a linked recipe without an active version', async () => {
        findMany.mockResolvedValue([{ id: 'pre-family', name: '波兰种', type: RecipeType.PRE_DOUGH, versions: [] }]);

        await expect(
            resolveDependencies({
                name: '吐司',
                type: RecipeType.MAIN,
                category: RecipeCategory.BREAD,
                ingredients: [{ name: '波兰种', flourRatio: 0.2 }],
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('RecipesService dependency graph validation', () => {
    type DependencyGraphValidator = {
        _validateDependencyGraph(
            parentFamilyId: string,
            parentRecipeName: string,
            ingredients: Array<{ name: string }>,
            linkedFamilies: Map<string, { id: string; name: string }>,
            tx: { recipeVersion: { findFirst: jest.Mock } },
        ): Promise<void>;
    };

    const service = new RecipesService({} as never, {} as never) as unknown as DependencyGraphValidator;

    const activeVersionWithChildren = (children: string[], productExtras: string[] = []) => ({
        components: [
            {
                ingredients: children.map((childId) => ({
                    preDoughId: childId,
                    extraId: null,
                })),
            },
        ],
        products: productExtras.map((childId) => ({
            ingredients: [{ linkedExtraId: childId }],
        })),
    });

    it('rejects circular references that are reached through product extras', async () => {
        const findFirst = jest.fn(({ where }) => {
            if (where.familyId === 'extra-child') {
                return activeVersionWithChildren([], ['parent-family']);
            }
            return null;
        });

        await expect(
            service._validateDependencyGraph(
                'parent-family',
                '吐司',
                [{ name: '焦糖酱' }],
                new Map([['焦糖酱', { id: 'extra-child', name: '焦糖酱' }]]),
                { recipeVersion: { findFirst } },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects dependency chains deeper than five recipe layers', async () => {
        const graph = new Map<string, string[]>([
            ['layer-1', ['layer-2']],
            ['layer-2', ['layer-3']],
            ['layer-3', ['layer-4']],
            ['layer-4', ['layer-5']],
            ['layer-5', []],
        ]);
        const findFirst = jest.fn(({ where }) => activeVersionWithChildren(graph.get(where.familyId) ?? []));

        await expect(
            service._validateDependencyGraph(
                'parent-family',
                '吐司',
                [{ name: '一层原料' }],
                new Map([['一层原料', { id: 'layer-1', name: '一层原料' }]]),
                { recipeVersion: { findFirst } },
            ),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});
