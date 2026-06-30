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
