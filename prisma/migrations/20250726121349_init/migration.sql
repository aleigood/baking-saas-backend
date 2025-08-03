-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ProductionTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IngredientType" AS ENUM ('STANDARD', 'UNTRACKED');

-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('MAIN', 'PRE_DOUGH', 'EXTRA');

-- CreateEnum
CREATE TYPE "ProductIngredientType" AS ENUM ('MIX_IN', 'FILLING', 'TOPPING');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
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
    "email" TEXT NOT NULL,
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
CREATE TABLE "Dough" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetTemp" DOUBLE PRECISION,
    "lossRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "procedure" TEXT[],

    CONSTRAINT "Dough_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoughIngredient" (
    "id" TEXT NOT NULL,
    "doughId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "isFlour" BOOLEAN NOT NULL DEFAULT false,
    "waterContent" DOUBLE PRECISION DEFAULT 0,
    "linkedPreDoughId" TEXT,

    CONSTRAINT "DoughIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseDoughWeight" DOUBLE PRECISION NOT NULL,
    "procedure" TEXT[],

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductIngredient" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProductIngredientType" NOT NULL,
    "ratio" DOUBLE PRECISION,
    "weightInGrams" DOUBLE PRECISION,
    "linkedExtraId" TEXT,

    CONSTRAINT "ProductIngredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "IngredientType" NOT NULL DEFAULT 'STANDARD',
    "defaultSkuId" TEXT,
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
    "specWeightInGrams" DOUBLE PRECISION NOT NULL,
    "ingredientId" TEXT NOT NULL,

    CONSTRAINT "IngredientSKU_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementRecord" (
    "id" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "packagesPurchased" INTEGER NOT NULL,
    "pricePerPackage" DECIMAL(65,30) NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcurementRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "status" "ProductionTaskStatus" NOT NULL DEFAULT 'PENDING',
    "plannedDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ProductionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "actualQuantity" DOUBLE PRECISION NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "ProductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngredientConsumptionLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "skuId" TEXT,
    "quantityInGrams" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "IngredientConsumptionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tenantId_email_key" ON "Invitation"("tenantId", "email");

-- CreateIndex
CREATE INDEX "RecipeFamily_tenantId_idx" ON "RecipeFamily"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeFamily_tenantId_name_deletedAt_key" ON "RecipeFamily"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "RecipeVersion_familyId_idx" ON "RecipeVersion"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_familyId_version_key" ON "RecipeVersion"("familyId", "version");

-- CreateIndex
CREATE INDEX "Dough_recipeVersionId_idx" ON "Dough"("recipeVersionId");

-- CreateIndex
CREATE INDEX "DoughIngredient_doughId_idx" ON "DoughIngredient"("doughId");

-- CreateIndex
CREATE INDEX "DoughIngredient_linkedPreDoughId_idx" ON "DoughIngredient"("linkedPreDoughId");

-- CreateIndex
CREATE INDEX "Product_recipeVersionId_idx" ON "Product"("recipeVersionId");

-- CreateIndex
CREATE INDEX "ProductIngredient_productId_idx" ON "ProductIngredient"("productId");

-- CreateIndex
CREATE INDEX "ProductIngredient_linkedExtraId_idx" ON "ProductIngredient"("linkedExtraId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_tenantId_name_deletedAt_key" ON "Ingredient"("tenantId", "name", "deletedAt");

-- CreateIndex
CREATE INDEX "ProductionTask_tenantId_idx" ON "ProductionTask"("tenantId");

-- CreateIndex
CREATE INDEX "ProductionTask_recipeVersionId_idx" ON "ProductionTask"("recipeVersionId");

-- CreateIndex
CREATE INDEX "ProductionTask_productId_idx" ON "ProductionTask"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionLog_taskId_key" ON "ProductionLog"("taskId");

-- CreateIndex
CREATE INDEX "ProductionLog_taskId_idx" ON "ProductionLog"("taskId");

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
ALTER TABLE "Dough" ADD CONSTRAINT "Dough_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoughIngredient" ADD CONSTRAINT "DoughIngredient_doughId_fkey" FOREIGN KEY ("doughId") REFERENCES "Dough"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoughIngredient" ADD CONSTRAINT "DoughIngredient_linkedPreDoughId_fkey" FOREIGN KEY ("linkedPreDoughId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductIngredient" ADD CONSTRAINT "ProductIngredient_linkedExtraId_fkey" FOREIGN KEY ("linkedExtraId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_defaultSkuId_fkey" FOREIGN KEY ("defaultSkuId") REFERENCES "IngredientSKU"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "IngredientSKU" ADD CONSTRAINT "IngredientSKU_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementRecord" ADD CONSTRAINT "ProcurementRecord_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "IngredientSKU"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTask" ADD CONSTRAINT "ProductionTask_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionLog" ADD CONSTRAINT "ProductionLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProductionTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "ProductionLog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientConsumptionLog" ADD CONSTRAINT "IngredientConsumptionLog_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "IngredientSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;
