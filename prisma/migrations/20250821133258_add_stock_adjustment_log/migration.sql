-- AlterTable
ALTER TABLE "public"."Ingredient" ADD COLUMN     "currentStockValue" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."IngredientStockAdjustment" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "changeInGrams" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngredientStockAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngredientStockAdjustment_ingredientId_idx" ON "public"."IngredientStockAdjustment"("ingredientId");

-- CreateIndex
CREATE INDEX "IngredientStockAdjustment_userId_idx" ON "public"."IngredientStockAdjustment"("userId");

-- AddForeignKey
ALTER TABLE "public"."IngredientStockAdjustment" ADD CONSTRAINT "IngredientStockAdjustment_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IngredientStockAdjustment" ADD CONSTRAINT "IngredientStockAdjustment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
