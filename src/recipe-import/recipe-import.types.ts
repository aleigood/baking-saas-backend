import { RecipeCategory, RecipeType } from '@prisma/client';
import { BatchImportRecipeDto } from '../recipes/dto/batch-import-recipe.dto';

export type RecipeImportReviewSeverity = 'INFO' | 'REVIEW' | 'BLOCKING';
export type RecipeImportReviewStatus = 'PENDING' | 'CONFIRMED' | 'EDITED';

export interface RecipeImportReviewItem {
    id: string;
    fieldId: string;
    recipeName: string;
    fieldPath: string;
    label: string;
    severity: RecipeImportReviewSeverity;
    status: RecipeImportReviewStatus;
    recognizedValue?: string | number | null;
    normalizedValue?: string | number | null;
    reason: string;
    derivation?: string;
    confidence?: number;
    diagnostics: Array<{
        label: string;
        reason: string;
        recognizedValue?: string | number | null;
        normalizedValue?: string | number | null;
        derivation?: string;
        confidence?: number;
    }>;
}

export interface RecipeImportAnalysis {
    recipes: BatchImportRecipeDto[];
    reviewItems: RecipeImportReviewItem[];
    ingredients: RecipeImportIngredient[];
    summary: {
        recipeCount: number;
        blockingCount: number;
        reviewCount: number;
        infoCount: number;
    };
    meta: {
        source: 'ai-import';
        provider: string;
        model: string;
        fileName?: string;
        analyzedAt: string;
    };
    diagnostics?: {
        extractedText?: string;
        rawModelOutput?: string;
        intermediateResult?: ModelIntermediateImportResult;
    };
}

export type RecipeImportIngredientStatus = 'MATCHED' | 'REVIEW' | 'NEW';

export interface RecipeImportIngredient {
    sourceName: string;
    normalizedName: string;
    ingredientId?: string;
    status: RecipeImportIngredientStatus;
    usages: string[];
    occurrenceCount: number;
}

export interface ModelRecipeCandidate {
    name: string;
    type: RecipeType;
    category: RecipeCategory;
    versions: Array<{
        notes: string;
        targetTemp?: number;
        lossRatio?: number;
        divisionLoss?: number;
        customWaterContent?: number;
        ingredients: Array<{
            name: string;
            ratio?: number;
            flourRatio?: number;
            isFlour?: boolean;
            waterContent?: number;
            recipeVersionId?: string;
        }>;
        products?: Array<{
            name: string;
            weight: number;
            fillings?: Array<{ name: string; ratio?: number; weightInGrams?: number }>;
            mixIn?: Array<{ name: string; ratio?: number; weightInGrams?: number }>;
            toppings?: Array<{ name: string; ratio?: number; weightInGrams?: number }>;
            procedure?: string[];
        }>;
        procedure?: string[];
    }>;
}

export interface ModelIntermediateIngredient {
    rawName: string;
    normalizedName?: string | null;
    rawAmount?: string | number | null;
    amount?: number | null;
    unit?: string | null;
    note?: string | null;
    isFlour?: boolean | null;
    waterContent?: number | null;
    evidence?: string | null;
}

export interface ModelIntermediateSection {
    name?: string | null;
    kind?: 'MAIN_DOUGH' | 'PRE_DOUGH' | 'EXTRA' | 'FILLING' | 'TOPPING' | 'MIX_IN' | 'NOTE' | null;
    items: ModelIntermediateIngredient[];
    evidence?: string | null;
}

export interface ModelIntermediateProduct {
    name?: string | null;
    sourceText?: string | null;
    unitWeight?: number | null;
    yieldCount?: number | null;
    totalWeight?: number | null;
    mixIn?: ModelIntermediateIngredient[];
    fillings?: ModelIntermediateIngredient[];
    toppings?: ModelIntermediateIngredient[];
    procedure?: string[];
    evidence?: string | null;
}

export interface ModelIntermediateRecipe {
    sourceName: string;
    suggestedName?: string | null;
    type: RecipeType;
    category: RecipeCategory;
    notes?: string | null;
    yieldText?: string | null;
    sections: ModelIntermediateSection[];
    products?: ModelIntermediateProduct[];
    procedure?: string[];
    evidence?: string | null;
}

export interface ModelIntermediateImportResult {
    intermediateRecipes: ModelIntermediateRecipe[];
    reviewItems?: Array<{
        recipeName: string;
        fieldPath: string;
        label: string;
        severity: RecipeImportReviewSeverity;
        recognizedValue?: string | number | null;
        normalizedValue?: string | number | null;
        reason: string;
        derivation?: string;
        confidence?: number;
    }>;
}

export interface ModelImportResult {
    recipes?: ModelRecipeCandidate[];
    intermediateRecipes?: ModelIntermediateRecipe[];
    reviewItems?: Array<{
        recipeName: string;
        fieldPath: string;
        label: string;
        severity: RecipeImportReviewSeverity;
        recognizedValue?: string | number | null;
        normalizedValue?: string | number | null;
        reason: string;
        derivation?: string;
        confidence?: number;
    }>;
    diagnostics?: {
        extractedText?: string;
        rawModelOutput?: string;
        intermediateResult?: ModelIntermediateImportResult;
    };
}
