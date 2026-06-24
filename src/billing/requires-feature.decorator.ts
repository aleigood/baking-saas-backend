import { SetMetadata } from '@nestjs/common';
export const ENTITLEMENT_FEATURE_KEY = 'entitlement-feature';
export type EntitlementFeature = 'costing' | 'statistics' | 'batchImport' | 'export';
export const RequiresFeature = (feature: EntitlementFeature) => SetMetadata(ENTITLEMENT_FEATURE_KEY, feature);
