-- CreateEnum
CREATE TYPE "RecipeCategory" AS ENUM ('BREAD', 'PASTRY', 'DESSERT', 'DRINK', 'OTHER');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProductionTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IngredientType" AS ENUM ('STANDARD', 'UNTRACKED', 'NON_INVENTORIED');

-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('MAIN', 'PRE_DOUGH', 'EXTRA');

-- CreateEnum
CREATE TYPE "ProductIngredientType" AS ENUM ('MIX_IN', 'FILLING', 'TOPPING');

-- CreateEnum
CREATE TYPE "SkuStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantUser" (
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "TenantUser_pkey" PRIMARY KEY ("userId","tenantId")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "RecipeFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeVersion" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeComponent" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetTemp" DECIMAL(65,30),
    "lossRatio" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "divisionLoss" DECIMAL(65,30) NOT NULL DEFAULT 0,
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
    "linkedPreDoughId" TEXT,

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

    CONSTRAINT "ProductIngredient_pkey" PRIMARY KEY ("id")
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
    "currentStockInGrams" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currentStockValue" DECIMAL(65,30) NOT NULL DEFAULT 0,
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
CREATE TABLE "IngredientStockAdjustment" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "changeInGrams" DECIMAL(65,30) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngredientStockAdjustment_pkey" PRIMARY KEY ("id")
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
    "quantity" INTEGER NOT NULL,

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
    "quantity" INTEGER NOT NULL,
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
    "quantity" INTEGER NOT NULL,
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

    CONSTRAINT "IngredientConsumptionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tenantId_phone_key" ON "Invitation"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "RecipeFamily_tenantId_idx" ON "RecipeFamily"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeFamily_tenantId_name_deletedAt_key" ON "RecipeFamily"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "RecipeVersion_familyId_idx" ON "RecipeVersion"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_familyId_version_key" ON "RecipeVersion"("familyId", "version");

-- CreateIndex
CREATE INDEX "RecipeComponent_recipeVersionId_idx" ON "RecipeComponent"("recipeVersionId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_componentId_idx" ON "ComponentIngredient"("componentId");

-- CreateIndex
CREATE INDEX "ComponentIngredient_linkedPreDoughId_idx" ON "ComponentIngredient"("linkedPreDoughId");

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
CREATE INDEX "ProductIngredient_ingredientId_idx" ON "ProductIngredient"("ingredientId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_tenantId_name_deletedAt_key" ON "Ingredient"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "ProcurementRecord_userId_idx" ON "ProcurementRecord"("userId");

-- CreateIndex
CREATE INDEX "IngredientStockAdjustment_ingredientId_idx" ON "IngredientStockAdjustment"("ingredientId");

-- CreateIndex
CREATE INDEX "IngredientStockAdjustment_userId_idx" ON "IngredientStockAdjustment"("userId");

-- CreateIndex
CREATE INDEX "ProductionTask_tenantId_idx" ON "ProductionTask"("tenantId");

-- CreateIndex
CREATE INDEX "ProductionTask_createdById_idx" ON "ProductionTask"("createdById");

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
ALTER TABLE "TenantUser" ADD CONSTRAINT "TenantUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantUser" ADD CONSTRAINT "TenantUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeFamily" ADD CONSTRAINT "RecipeFamily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeVersion" ADD CONSTRAINT "RecipeVersion_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "RecipeFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeComponent" ADD CONSTRAINT "RecipeComponent_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "RecipeComponent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComponentIngredient" ADD CONSTRAINT "ComponentIngredient_linkedPreDoughId_fkey" FOREIGN KEY ("linkedPreDoughId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_linkedExtraId_fkey" FOREIGN KEY ("linkedExtraId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "IngredientStockAdjustment" ADD CONSTRAINT "IngredientStockAdjustment_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientStockAdjustment" ADD CONSTRAINT "IngredientStockAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
