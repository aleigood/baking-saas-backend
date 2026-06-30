-- CreateEnum
CREATE TYPE "RecipeCategory" AS ENUM ('BREAD', 'PASTRY', 'DESSERT', 'DRINK', 'OTHER');

-- CreateEnum
CREATE TYPE "GlobalRole" AS ENUM ('USER', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "TenantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "SmsPurpose" AS ENUM ('REGISTER');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProductionTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IngredientType" AS ENUM ('STANDARD', 'UNTRACKED', 'NON_INVENTORIED', 'SELF_MADE');

-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('MAIN', 'PRE_DOUGH', 'EXTRA');

-- CreateEnum
CREATE TYPE "ProductIngredientType" AS ENUM ('MIX_IN', 'FILLING', 'TOPPING');

-- CreateEnum
CREATE TYPE "SkuStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "TaskItemRole" AS ENUM ('FINAL_PRODUCT', 'PREP_INGREDIENT');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "EntitlementTier" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "EntitlementPolicyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'CLOSED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentRefundStatus" AS ENUM ('PENDING', 'SUCCESS', 'CLOSED', 'ABNORMAL');

-- CreateEnum
CREATE TYPE "RecipeEditorSessionStatus" AS ENUM ('PENDING', 'APPROVED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecipeDraftStatus" AS ENUM ('DRAFT', 'SYNCED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneVerifiedAt" TIMESTAMP(3),
    "name" TEXT,
    "avatarUrl" TEXT,
    "password" TEXT,
    "wechatOpenId" TEXT,
    "wechatUnionId" TEXT,
    "globalRole" "GlobalRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsVerificationCode" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "purpose" "SmsPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "requestIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "trialStartedAt" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "freeTierResetAt" TIMESTAMP(3),
    "trialEntitlementPolicyId" TEXT,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeEditorSession" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "status" "RecipeEditorSessionStatus" NOT NULL DEFAULT 'PENDING',
    "tenantId" TEXT,
    "userId" TEXT,
    "actorRole" TEXT NOT NULL DEFAULT 'USER',
    "tenantRole" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeEditorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT,
    "actorRole" TEXT NOT NULL DEFAULT 'USER',
    "title" TEXT NOT NULL,
    "status" "RecipeDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "payload" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantUser" (
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL DEFAULT 'MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "TenantUser_pkey" PRIMARY KEY ("userId","tenantId")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "TenantRole" NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPlan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "priceInCents" INTEGER NOT NULL,
    "originalPriceInCents" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tier" "EntitlementTier" NOT NULL DEFAULT 'PRO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntitlementPolicy" (
    "id" TEXT NOT NULL,
    "tier" "EntitlementTier" NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EntitlementPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntitlementPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSubscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "entitlementPolicyId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "planId" TEXT NOT NULL,
    "entitlementPolicyId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "amountInCents" INTEGER NOT NULL,
    "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "channel" TEXT NOT NULL DEFAULT 'wechat',
    "prepayId" TEXT,
    "transactionId" TEXT,
    "refundAmountInCents" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL,
    "refundNo" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "PaymentRefundStatus" NOT NULL DEFAULT 'PENDING',
    "wechatRefundId" TEXT,
    "successAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "statusCode" INTEGER NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeFamily" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "RecipeType" NOT NULL,
    "category" "RecipeCategory" NOT NULL DEFAULT 'BREAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "freeTierEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RecipeFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeVersion" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "notes" TEXT,
    "changeSummary" JSONB,
    "createdById" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeOperationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "versionId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeOperationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeComponent" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetTemp" DECIMAL(65,30),
    "lossRatio" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "divisionLoss" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "customWaterContent" DECIMAL(65,30),
    "procedure" TEXT[],

    CONSTRAINT "RecipeComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComponentIngredient" (
    "id" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "ratio" DECIMAL(65,30),
    "flourRatio" DECIMAL(65,30),
    "ingredientId" TEXT,
    "preDoughId" TEXT,
    "preDoughVersionId" TEXT,
    "extraId" TEXT,
    "extraVersionId" TEXT,

    CONSTRAINT "ComponentIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseDoughWeight" DECIMAL(65,30) NOT NULL,
    "procedure" TEXT[],
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIngredient" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "type" "ProductIngredientType" NOT NULL,
    "ingredientId" TEXT,
    "ratio" DECIMAL(65,30),
    "weightInGrams" DECIMAL(65,30),
    "linkedExtraId" TEXT,
    "linkedExtraVersionId" TEXT,

    CONSTRAINT "ProductIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientPreset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isFlour" BOOLEAN NOT NULL DEFAULT false,
    "waterContent" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientPreset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "IngredientType" NOT NULL DEFAULT 'STANDARD',
    "isFlour" BOOLEAN NOT NULL DEFAULT false,
    "waterContent" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "activeSkuId" TEXT,
    "shelfLife" INTEGER NOT NULL DEFAULT 0,
    "recipeFamilyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientSKU" (
    "id" TEXT NOT NULL,
    "brand" TEXT,
    "specName" TEXT NOT NULL,
    "specWeightInGrams" DECIMAL(65,30) NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "status" "SkuStatus" NOT NULL DEFAULT 'INACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientSKU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementRecord" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "packagesPurchased" INTEGER NOT NULL,
    "pricePerPackage" DECIMAL(65,30) NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "ProcurementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "ProductionTaskStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "recipeSnapshot" JSONB,
    "executionStartedAt" TIMESTAMP(3),
    "executionStartedById" TEXT,
    "executionBaseline" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,

    CONSTRAINT "ProductionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionTaskItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "role" "TaskItemRole" NOT NULL DEFAULT 'FINAL_PRODUCT',

    CONSTRAINT "ProductionTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "ProductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionTaskSpoilageLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionTaskSpoilageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionTaskOverproductionLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionTaskOverproductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientConsumptionLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "skuId" TEXT,
    "quantityInGrams" DECIMAL(65,30) NOT NULL,
    "unitPrice" DECIMAL(65,30),

    CONSTRAINT "IngredientConsumptionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_wechatOpenId_key" ON "User"("wechatOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "User_wechatUnionId_key" ON "User"("wechatUnionId");

-- CreateIndex
CREATE INDEX "SmsVerificationCode_phone_purpose_createdAt_idx" ON "SmsVerificationCode"("phone", "purpose", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SmsVerificationCode_requestIp_createdAt_idx" ON "SmsVerificationCode"("requestIp", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SmsVerificationCode_expiresAt_idx" ON "SmsVerificationCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeEditorSession_token_key" ON "RecipeEditorSession"("token");

-- CreateIndex
CREATE INDEX "RecipeEditorSession_status_expiresAt_idx" ON "RecipeEditorSession"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "RecipeEditorSession_tenantId_createdAt_idx" ON "RecipeEditorSession"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "RecipeDraft_tenantId_status_updatedAt_idx" ON "RecipeDraft"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "RecipeDraft_createdById_createdAt_idx" ON "RecipeDraft"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tenantId_phone_key" ON "Invitation"("tenantId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPlan_code_key" ON "SubscriptionPlan"("code");

-- CreateIndex
CREATE INDEX "SubscriptionPlan_isActive_sortOrder_idx" ON "SubscriptionPlan"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "EntitlementPolicy_tier_status_isDefault_idx" ON "EntitlementPolicy"("tier", "status", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "EntitlementPolicy_tier_version_key" ON "EntitlementPolicy"("tier", "version");

-- CreateIndex
CREATE INDEX "TenantSubscription_tenantId_status_idx" ON "TenantSubscription"("tenantId", "status");

-- CreateIndex
CREATE INDEX "TenantSubscription_expiresAt_idx" ON "TenantSubscription"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_orderNo_key" ON "PaymentOrder"("orderNo");

-- CreateIndex
CREATE INDEX "PaymentOrder_tenantId_status_idx" ON "PaymentOrder"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PaymentOrder_userId_idx" ON "PaymentOrder"("userId");

-- CreateIndex
CREATE INDEX "PaymentOrder_createdAt_idx" ON "PaymentOrder"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRefund_refundNo_key" ON "PaymentRefund"("refundNo");

-- CreateIndex
CREATE INDEX "PaymentRefund_orderId_status_idx" ON "PaymentRefund"("orderId", "status");

-- CreateIndex
CREATE INDEX "PaymentRefund_createdAt_idx" ON "PaymentRefund"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "RecipeFamily_tenantId_idx" ON "RecipeFamily"("tenantId");

-- CreateIndex
CREATE INDEX "RecipeFamily_tenantId_type_freeTierEnabled_idx" ON "RecipeFamily"("tenantId", "type", "freeTierEnabled");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeFamily_tenantId_name_deletedAt_key" ON "RecipeFamily"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "RecipeVersion_familyId_idx" ON "RecipeVersion"("familyId");

-- CreateIndex
CREATE INDEX "RecipeVersion_createdById_idx" ON "RecipeVersion"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_familyId_version_key" ON "RecipeVersion"("familyId", "version");

-- CreateIndex
CREATE INDEX "RecipeOperationLog_familyId_createdAt_idx" ON "RecipeOperationLog"("familyId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RecipeOperationLog_tenantId_createdAt_idx" ON "RecipeOperationLog"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RecipeOperationLog_actorUserId_createdAt_idx" ON "RecipeOperationLog"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RecipeComponent_recipeVersionId_idx" ON "RecipeComponent"("recipeVersionId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_componentId_idx" ON "ComponentIngredient"("componentId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_preDoughId_idx" ON "ComponentIngredient"("preDoughId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_preDoughVersionId_idx" ON "ComponentIngredient"("preDoughVersionId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_extraId_idx" ON "ComponentIngredient"("extraId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_extraVersionId_idx" ON "ComponentIngredient"("extraVersionId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_ingredientId_idx" ON "ComponentIngredient"("ingredientId");

-- CreateIndex
CREATE INDEX "Product_recipeVersionId_idx" ON "Product"("recipeVersionId");

-- CreateIndex
CREATE INDEX "Product_deletedAt_idx" ON "Product"("deletedAt");

-- CreateIndex
CREATE INDEX "ProductIngredient_productId_idx" ON "ProductIngredient"("productId");

-- CreateIndex
CREATE INDEX "ProductIngredient_linkedExtraId_idx" ON "ProductIngredient"("linkedExtraId");

-- CreateIndex
CREATE INDEX "ProductIngredient_linkedExtraVersionId_idx" ON "ProductIngredient"("linkedExtraVersionId");

-- CreateIndex
CREATE INDEX "ProductIngredient_ingredientId_idx" ON "ProductIngredient"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "IngredientPreset_name_key" ON "IngredientPreset"("name");

-- CreateIndex
CREATE INDEX "IngredientPreset_isActive_sortOrder_idx" ON "IngredientPreset"("isActive", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_recipeFamilyId_key" ON "Ingredient"("recipeFamilyId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_tenantId_name_deletedAt_key" ON "Ingredient"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "ProcurementRecord_userId_idx" ON "ProcurementRecord"("userId");

-- CreateIndex
CREATE INDEX "ProcurementRecord_skuId_purchaseDate_idx" ON "ProcurementRecord"("skuId", "purchaseDate" DESC);

-- CreateIndex
CREATE INDEX "ProductionTask_tenantId_idx" ON "ProductionTask"("tenantId");

-- CreateIndex
CREATE INDEX "ProductionTask_createdById_idx" ON "ProductionTask"("createdById");

-- CreateIndex
CREATE INDEX "ProductionTask_executionStartedById_idx" ON "ProductionTask"("executionStartedById");

-- CreateIndex
CREATE INDEX "ProductionTaskItem_taskId_idx" ON "ProductionTaskItem"("taskId");

-- CreateIndex
CREATE INDEX "ProductionTaskItem_productId_idx" ON "ProductionTaskItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionLog_taskId_key" ON "ProductionLog"("taskId");

-- CreateIndex
CREATE INDEX "ProductionLog_taskId_idx" ON "ProductionLog"("taskId");

-- CreateIndex
CREATE INDEX "ProductionTaskSpoilageLog_productionLogId_idx" ON "ProductionTaskSpoilageLog"("productionLogId");

-- CreateIndex
CREATE INDEX "ProductionTaskSpoilageLog_productId_idx" ON "ProductionTaskSpoilageLog"("productId");

-- CreateIndex
CREATE INDEX "ProductionTaskOverproductionLog_productionLogId_idx" ON "ProductionTaskOverproductionLog"("productionLogId");

-- CreateIndex
CREATE INDEX "ProductionTaskOverproductionLog_productId_idx" ON "ProductionTaskOverproductionLog"("productId");

-- CreateIndex
CREATE INDEX "IngredientConsumptionLog_productionLogId_idx" ON "IngredientConsumptionLog"("productionLogId");

-- CreateIndex
CREATE INDEX "IngredientConsumptionLog_ingredientId_idx" ON "IngredientConsumptionLog"("ingredientId");

-- CreateIndex
CREATE INDEX "IngredientConsumptionLog_skuId_idx" ON "IngredientConsumptionLog"("skuId");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_trialEntitlementPolicyId_fkey" FOREIGN KEY ("trialEntitlementPolicyId") REFERENCES "EntitlementPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeEditorSession" ADD CONSTRAINT "RecipeEditorSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeEditorSession" ADD CONSTRAINT "RecipeEditorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeDraft" ADD CONSTRAINT "RecipeDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeDraft" ADD CONSTRAINT "RecipeDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantUser" ADD CONSTRAINT "TenantUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantUser" ADD CONSTRAINT "TenantUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSubscription" ADD CONSTRAINT "TenantSubscription_entitlementPolicyId_fkey" FOREIGN KEY ("entitlementPolicyId") REFERENCES "EntitlementPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_entitlementPolicyId_fkey" FOREIGN KEY ("entitlementPolicyId") REFERENCES "EntitlementPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "TenantSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeFamily" ADD CONSTRAINT "RecipeFamily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeVersion" ADD CONSTRAINT "RecipeVersion_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "RecipeFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeVersion" ADD CONSTRAINT "RecipeVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOperationLog" ADD CONSTRAINT "RecipeOperationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOperationLog" ADD CONSTRAINT "RecipeOperationLog_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "RecipeFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOperationLog" ADD CONSTRAINT "RecipeOperationLog_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "RecipeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeOperationLog" ADD CONSTRAINT "RecipeOperationLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeComponent" ADD CONSTRAINT "RecipeComponent_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_preDoughId_fkey" FOREIGN KEY ("preDoughId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_preDoughVersionId_fkey" FOREIGN KEY ("preDoughVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_extraId_fkey" FOREIGN KEY ("extraId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_extraVersionId_fkey" FOREIGN KEY ("extraVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "RecipeComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_linkedExtraId_fkey" FOREIGN KEY ("linkedExtraId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_linkedExtraVersionId_fkey" FOREIGN KEY ("linkedExtraVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_recipeFamilyId_fkey" FOREIGN KEY ("recipeFamilyId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_activeSkuId_fkey" FOREIGN KEY ("activeSkuId") REFERENCES "IngredientSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientSKU" ADD CONSTRAINT "IngredientSKU_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementRecord" ADD CONSTRAINT "ProcurementRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementRecord" ADD CONSTRAINT "ProcurementRecord_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "IngredientSKU"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_executionStartedById_fkey" FOREIGN KEY ("executionStartedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskItem" ADD CONSTRAINT "ProductionTaskItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProductionTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskItem" ADD CONSTRAINT "ProductionTaskItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionLog" ADD CONSTRAINT "ProductionLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProductionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskSpoilageLog" ADD CONSTRAINT "ProductionTaskSpoilageLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "ProductionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskSpoilageLog" ADD CONSTRAINT "ProductionTaskSpoilageLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskOverproductionLog" ADD CONSTRAINT "ProductionTaskOverproductionLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "ProductionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskOverproductionLog" ADD CONSTRAINT "ProductionTaskOverproductionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "ProductionLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "IngredientSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;
