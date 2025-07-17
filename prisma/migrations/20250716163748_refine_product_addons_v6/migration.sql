/*
  Warnings:

  - You are about to drop the column `keyPoints` on the `RecipeFamily` table. All the data in the column will be lost.
  - You are about to drop the `ProductFilling` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProductIngredient` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "AddOnType" AS ENUM ('FILLING', 'TOPPING');

-- DropForeignKey
ALTER TABLE "ProductFilling" DROP CONSTRAINT "ProductFilling_extraId_fkey";

-- DropForeignKey
ALTER TABLE "ProductFilling" DROP CONSTRAINT "ProductFilling_productId_fkey";

-- DropForeignKey
ALTER TABLE "ProductIngredient" DROP CONSTRAINT "ProductIngredient_ingredientId_fkey";

-- DropForeignKey
ALTER TABLE "ProductIngredient" DROP CONSTRAINT "ProductIngredient_productId_fkey";

-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "hydration" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "RecipeFamily" DROP COLUMN "keyPoints";

-- DropTable
DROP TABLE "ProductFilling";

-- DropTable
DROP TABLE "ProductIngredient";

-- CreateTable
CREATE TABLE "Procedure" (
    "id" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recipeFamilyId" TEXT,
    "productId" TEXT,

    CONSTRAINT "Procedure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMixIn" (
    "ratio" DOUBLE PRECISION NOT NULL,
    "productId" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,

    CONSTRAINT "ProductMixIn_pkey" PRIMARY KEY ("productId","ingredientId")
);

-- CreateTable
CREATE TABLE "ProductAddOn" (
    "weight" DOUBLE PRECISION NOT NULL,
    "type" "AddOnType" NOT NULL DEFAULT 'FILLING',
    "productId" TEXT NOT NULL,
    "extraId" TEXT NOT NULL,

    CONSTRAINT "ProductAddOn_pkey" PRIMARY KEY ("productId","extraId","type")
);

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_recipeFamilyId_fkey" FOREIGN KEY ("recipeFamilyId") REFERENCES "RecipeFamily"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMixIn" ADD CONSTRAINT "ProductMixIn_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMixIn" ADD CONSTRAINT "ProductMixIn_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAddOn" ADD CONSTRAINT "ProductAddOn_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAddOn" ADD CONSTRAINT "ProductAddOn_extraId_fkey" FOREIGN KEY ("extraId") REFERENCES "Extra"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
