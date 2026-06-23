import { RecipeType } from '@prisma/client';

export interface DependencyUpgradeItemDto {
    familyId: string;
    familyName: string;
    type: RecipeType;
    currentVersionId: string;
    updatedDependencyFamilyIds: string[];
    depth: number;
}

export interface DependencyUpgradePlanDto {
    sourceFamilyId: string;
    sourceVersionId: string;
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

export interface PendingDependencyItemDto {
    familyId: string;
    familyName: string;
}

export interface PendingDependencyUpgradePlanDto {
    familyId: string;
    familyName: string;
    currentVersionId: string;
    dependencies: PendingDependencyItemDto[];
}
