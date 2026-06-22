import { RecipeType } from '@prisma/client';

export interface DependencyUpgradeItemDto {
    familyId: string;
    familyName: string;
    type: RecipeType;
    currentVersionId: string;
    currentVersion: number;
    nextVersion: number;
    depth: number;
}

export interface DependencyUpgradePlanDto {
    sourceFamilyId: string;
    sourceVersionId: string;
    sourceVersion: number;
    affectedRecipes: DependencyUpgradeItemDto[];
}

export interface ApplyDependencyUpgradeResultDto {
    upgradedRecipes: Array<{
        familyId: string;
        familyName: string;
        versionId: string;
        version: number;
    }>;
}
