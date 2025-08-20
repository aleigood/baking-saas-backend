/*
  Warnings:

  - You are about to drop the column `currentPricePerPackage` on the `Ingredient` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Ingredient" DROP CONSTRAINT "Ingredient_activeSkuId_fkey";

-- AlterTable
ALTER TABLE "public"."Ingredient" DROP COLUMN "currentPricePerPackage",
ADD COLUMN     "currentPricePerGram" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "public"."Ingredient" ADD CONSTRAINT "Ingredient_activeSkuId_fkey" FOREIGN KEY ("activeSkuId") REFERENCES "public"."IngredientSKU"("id") ON DELETE SET NULL ON UPDATE CASCADE;
