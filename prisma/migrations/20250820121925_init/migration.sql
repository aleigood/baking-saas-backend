-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "public"."UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "public"."TenantStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "public"."InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."ProductionTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."IngredientType" AS ENUM ('STANDARD', 'UNTRACKED');

-- CreateEnum
CREATE TYPE "public"."RecipeType" AS ENUM ('MAIN', 'PRE_DOUGH', 'EXTRA');

-- CreateEnum
CREATE TYPE "public"."ProductIngredientType" AS ENUM ('MIX_IN', 'FILLING', 'TOPPING');

-- CreateEnum
CREATE TYPE "public"."SkuStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "password" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'MEMBER',
    "status" "public"."UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "public"."TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TenantUser" (
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'MEMBER',
    "status" "public"."UserStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "TenantUser_pkey" PRIMARY KEY ("userId","tenantId")
);

-- CreateTable
CREATE TABLE "public"."Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL,
    "status" "public"."InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeFamily" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "public"."RecipeType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecipeFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RecipeVersion" (
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
CREATE TABLE "public"."Dough" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetTemp" DOUBLE PRECISION,
    "lossRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "procedure" TEXT[],

    CONSTRAINT "Dough_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DoughIngredient" (
    "id" TEXT NOT NULL,
    "doughId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "linkedPreDoughId" TEXT,

    CONSTRAINT "DoughIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Product" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseDoughWeight" DOUBLE PRECISION NOT NULL,
    "procedure" TEXT[],

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductIngredient" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."ProductIngredientType" NOT NULL,
    "ratio" DOUBLE PRECISION,
    "weightInGrams" DOUBLE PRECISION,
    "linkedExtraId" TEXT,

    CONSTRAINT "ProductIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Ingredient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."IngredientType" NOT NULL DEFAULT 'STANDARD',
    "isFlour" BOOLEAN NOT NULL DEFAULT false,
    "waterContent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "activeSkuId" TEXT,
    "currentStockInGrams" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currentPricePerGram" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IngredientSKU" (
    "id" TEXT NOT NULL,
    "brand" TEXT,
    "specName" TEXT NOT NULL,
    "specWeightInGrams" DOUBLE PRECISION NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "status" "public"."SkuStatus" NOT NULL DEFAULT 'INACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngredientSKU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProcurementRecord" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "packagesPurchased" INTEGER NOT NULL,
    "pricePerPackage" DECIMAL(65,30) NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductionTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "public"."ProductionTaskStatus" NOT NULL DEFAULT 'PENDING',
    "plannedDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductionTaskItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ProductionTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProductionLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "ProductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IngredientConsumptionLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "skuId" TEXT,
    "quantityInGrams" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "IngredientConsumptionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "public"."User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tenantId_phone_key" ON "public"."Invitation"("tenantId", "phone");

-- CreateIndex
CREATE INDEX "RecipeFamily_tenantId_idx" ON "public"."RecipeFamily"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeFamily_tenantId_name_deletedAt_key" ON "public"."RecipeFamily"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "RecipeVersion_familyId_idx" ON "public"."RecipeVersion"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_familyId_version_key" ON "public"."RecipeVersion"("familyId", "version");

-- CreateIndex
CREATE INDEX "Dough_recipeVersionId_idx" ON "public"."Dough"("recipeVersionId");

-- CreateIndex
CREATE INDEX "DoughIngredient_doughId_idx" ON "public"."DoughIngredient"("doughId");

-- CreateIndex
CREATE INDEX "DoughIngredient_linkedPreDoughId_idx" ON "public"."DoughIngredient"("linkedPreDoughId");

-- CreateIndex
CREATE INDEX "Product_recipeVersionId_idx" ON "public"."Product"("recipeVersionId");

-- CreateIndex
CREATE INDEX "ProductIngredient_productId_idx" ON "public"."ProductIngredient"("productId");

-- CreateIndex
CREATE INDEX "ProductIngredient_linkedExtraId_idx" ON "public"."ProductIngredient"("linkedExtraId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_tenantId_name_deletedAt_key" ON "public"."Ingredient"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "ProductionTask_tenantId_idx" ON "public"."ProductionTask"("tenantId");

-- CreateIndex
CREATE INDEX "ProductionTaskItem_taskId_idx" ON "public"."ProductionTaskItem"("taskId");

-- CreateIndex
CREATE INDEX "ProductionTaskItem_productId_idx" ON "public"."ProductionTaskItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionLog_taskId_key" ON "public"."ProductionLog"("taskId");

-- CreateIndex
CREATE INDEX "ProductionLog_taskId_idx" ON "public"."ProductionLog"("taskId");

-- CreateIndex
CREATE INDEX "IngredientConsumptionLog_productionLogId_idx" ON "public"."IngredientConsumptionLog"("productionLogId");

-- CreateIndex
CREATE INDEX "IngredientConsumptionLog_ingredientId_idx" ON "public"."IngredientConsumptionLog"("ingredientId");

-- CreateIndex
CREATE INDEX "IngredientConsumptionLog_skuId_idx" ON "public"."IngredientConsumptionLog"("skuId");

-- AddForeignKey
ALTER TABLE "public"."TenantUser" ADD CONSTRAINT "TenantUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TenantUser" ADD CONSTRAINT "TenantUser_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Invitation" ADD CONSTRAINT "Invitation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeFamily" ADD CONSTRAINT "RecipeFamily_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RecipeVersion" ADD CONSTRAINT "RecipeVersion_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "public"."RecipeFamily"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Dough" ADD CONSTRAINT "Dough_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "public"."RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoughIngredient" ADD CONSTRAINT "DoughIngredient_doughId_fkey" FOREIGN KEY ("doughId") REFERENCES "public"."Dough"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoughIngredient" ADD CONSTRAINT "DoughIngredient_linkedPreDoughId_fkey" FOREIGN KEY ("linkedPreDoughId") REFERENCES "public"."RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Product" ADD CONSTRAINT "Product_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "public"."RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductIngredient" ADD CONSTRAINT "ProductIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductIngredient" ADD CONSTRAINT "ProductIngredient_linkedExtraId_fkey" FOREIGN KEY ("linkedExtraId") REFERENCES "public"."RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ingredient" ADD CONSTRAINT "Ingredient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Ingredient" ADD CONSTRAINT "Ingredient_activeSkuId_fkey" FOREIGN KEY ("activeSkuId") REFERENCES "public"."IngredientSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IngredientSKU" ADD CONSTRAINT "IngredientSKU_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProcurementRecord" ADD CONSTRAINT "ProcurementRecord_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "public"."IngredientSKU"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductionTask" ADD CONSTRAINT "ProductionTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "public"."Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductionTaskItem" ADD CONSTRAINT "ProductionTaskItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "public"."ProductionTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductionTaskItem" ADD CONSTRAINT "ProductionTaskItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductionLog" ADD CONSTRAINT "ProductionLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "public"."ProductionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "public"."ProductionLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "public"."IngredientSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;
