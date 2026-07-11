import { ProductIngredientType } from '@prisma/client';
import { CostingService } from '../costing/costing.service';
import { EntitlementsService } from '../billing/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionTasksService } from './production-tasks.service';

const ingredient = (id: string, isFlour = false) => ({
    id,
    name: id,
    isFlour,
    waterContent: 0,
    activeSku: null,
});

const extraRecipe = (
    id: string,
    baseIngredient: ReturnType<typeof ingredient>,
    lossRatio: number,
    divisionLoss: number,
) => ({
    id,
    name: id,
    versions: [
        {
            components: [
                {
                    lossRatio,
                    divisionLoss,
                    ingredients: [
                        {
                            ratio: 1,
                            ingredientId: baseIngredient.id,
                            ingredient: baseIngredient,
                            linkedPreDough: null,
                            linkedExtra: null,
                        },
                    ],
                },
            ],
        },
    ],
});

const buildProduct = () => {
    const flour = ingredient('flour', true);
    const directFilling = ingredient('direct-filling');
    const fillingBase = ingredient('filling-base');
    const toppingBase = ingredient('topping-base');
    const mixInBase = ingredient('mix-in-base');
    const nestedBase = ingredient('nested-base');
    const selfMadeFilling = extraRecipe('self-made-filling', fillingBase, 0.1, 0.5);
    const selfMadeTopping = extraRecipe('self-made-topping', toppingBase, 0.05, 0.2);
    const selfMadeMixIn = extraRecipe('self-made-mix-in', mixInBase, 0.2, 999);
    const nestedExtra = extraRecipe('nested-extra', nestedBase, 0, 999);
    const parentExtra = {
        id: 'parent-extra',
        name: 'parent-extra',
        versions: [
            {
                components: [
                    {
                        lossRatio: 0,
                        divisionLoss: 0.25,
                        ingredients: [
                            {
                                ratio: 1,
                                ingredientId: null,
                                ingredient: null,
                                linkedPreDough: null,
                                linkedExtra: nestedExtra,
                            },
                        ],
                    },
                ],
            },
        ],
    };

    return {
        id: 'product',
        deletedAt: null,
        baseDoughWeight: 100,
        recipeVersion: {
            components: [
                {
                    lossRatio: 0.1,
                    divisionLoss: 10,
                    ingredients: [
                        {
                            ratio: 1,
                            flourRatio: null,
                            ingredientId: flour.id,
                            ingredient: flour,
                            linkedPreDough: null,
                            linkedExtra: null,
                        },
                    ],
                },
            ],
        },
        ingredients: [
            {
                type: ProductIngredientType.FILLING,
                weightInGrams: 20,
                ingredientId: directFilling.id,
                ingredient: directFilling,
                linkedExtra: null,
            },
            {
                type: ProductIngredientType.FILLING,
                weightInGrams: 10,
                ingredientId: null,
                ingredient: null,
                linkedExtra: selfMadeFilling,
            },
            {
                type: ProductIngredientType.MIX_IN,
                ratio: 0.2,
                ingredientId: null,
                ingredient: null,
                linkedExtra: selfMadeMixIn,
            },
            {
                type: ProductIngredientType.TOPPING,
                weightInGrams: 5,
                ingredientId: null,
                ingredient: null,
                linkedExtra: selfMadeTopping,
            },
            {
                type: ProductIngredientType.FILLING,
                weightInGrams: 4,
                ingredientId: null,
                ingredient: null,
                linkedExtra: parentExtra,
            },
        ],
    };
};

describe('product ingredient loss calculation', () => {
    const costingService = new CostingService({} as PrismaService);
    const productionTasksService = new ProductionTasksService(
        {} as PrismaService,
        costingService,
        {} as EntitlementsService,
    );

    it.each([
        ['production task', () => (productionTasksService as any)._getTheoreticalMaterialRequirement(buildProduct())],
        ['cost forecast', () => (costingService as any)._getFlattenedIngredients(buildProduct())],
    ])(
        'applies recipe portion reserve only to directly portioned self-made extras in %s calculation',
        (_name, calculate) => {
            const result = calculate();

            expect(result.get('direct-filling').toNumber()).toBeCloseTo(20, 6);
            expect(result.get('filling-base').toNumber()).toBeCloseTo(10.5 / 0.9, 6);
            expect(result.get('topping-base').toNumber()).toBeCloseTo(5.2 / 0.95, 6);
            expect(result.get('nested-base').toNumber()).toBeCloseTo(4.25, 6);

            const mixInOutputAfterMainLoss = (20 * 1.1) / 0.9;
            expect(result.get('mix-in-base').toNumber()).toBeCloseTo(mixInOutputAfterMainLoss / 0.8, 6);
        },
    );
});
