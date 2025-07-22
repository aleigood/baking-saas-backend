/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Dough` table. All the data in the column will be lost.
  - You are about to drop the column `recipeFamilyId` on the `Dough` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Dough` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Extra` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Extra` table. All the data in the column will be lost.
  - You are about to drop the column `recipeFamilyId` on the `Procedure` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the column `recipeFamilyId` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Product` table. All the data in the column will be lost.
  - You are about to drop the column `createdAt` on the `RecipeFamily` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `RecipeFamily` table. All the data in the column will be lost.
  - Added the required column `recipeVersionId` to the `Dough` table without a default value. This is not possible if the table is not empty.
  - Added the required column `recipeVersionId` to the `Product` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Dough" DROP CONSTRAINT "Dough_recipeFamilyId_fkey";

-- DropForeignKey
ALTER TABLE "Procedure" DROP CONSTRAINT "Procedure_recipeFamilyId_fkey";

-- DropForeignKey
ALTER TABLE "Product" DROP CONSTRAINT "Product_recipeFamilyId_fkey";

-- AlterTable
ALTER TABLE "Dough" DROP COLUMN "createdAt",
DROP COLUMN "recipeFamilyId",
DROP COLUMN "updatedAt",
ADD COLUMN     "recipeVersionId" TEXT NOT NULL,
ADD COLUMN     "wastageFactor" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Extra" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt",
ADD COLUMN     "wastageFactor" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Procedure" DROP COLUMN "recipeFamilyId",
ADD COLUMN     "recipeVersionId" TEXT;

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "createdAt",
DROP COLUMN "recipeFamilyId",
DROP COLUMN "updatedAt",
ADD COLUMN     "recipeVersionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "RecipeFamily" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt";

-- CreateTable
CREATE TABLE "RecipeVersion" (
    "id" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "versionName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipeFamilyId" TEXT NOT NULL,

    CONSTRAINT "RecipeVersion_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "RecipeVersion" ADD CONSTRAINT "RecipeVersion_recipeFamilyId_fkey" FOREIGN KEY ("recipeFamilyId") REFERENCES "RecipeFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dough" ADD CONSTRAINT "Dough_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
