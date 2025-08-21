/*
  Warnings:

  - You are about to drop the column `name` on the `DoughIngredient` table. All the data in the column will be lost.
  - You are about to drop the column `currentPricePerGram` on the `Ingredient` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `ProductIngredient` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."DoughIngredient" DROP COLUMN "name",
ADD COLUMN     "ingredientId" TEXT;

-- AlterTable
ALTER TABLE "public"."Ingredient" DROP COLUMN "currentPricePerGram";

-- AlterTable
ALTER TABLE "public"."ProductIngredient" DROP COLUMN "name",
ADD COLUMN     "ingredientId" TEXT;

-- CreateIndex
CREATE INDEX "DoughIngredient_ingredientId_idx" ON "public"."DoughIngredient"("ingredientId");

-- CreateIndex
CREATE INDEX "ProductIngredient_ingredientId_idx" ON "public"."ProductIngredient"("ingredientId");

-- AddForeignKey
ALTER TABLE "public"."DoughIngredient" ADD CONSTRAINT "DoughIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProductIngredient" ADD CONSTRAINT "ProductIngredient_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "public"."Ingredient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
