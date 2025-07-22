/*
  Warnings:

  - You are about to drop the column `wastageFactor` on the `Dough` table. All the data in the column will be lost.
  - You are about to drop the column `wastageFactor` on the `Extra` table. All the data in the column will be lost.
  - You are about to drop the column `versionName` on the `RecipeVersion` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[recipeFamilyId,versionNumber]` on the table `RecipeVersion` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `Extra` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `Product` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `RecipeFamily` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `RecipeVersion` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Dough" DROP COLUMN "wastageFactor",
ADD COLUMN     "lossRatio" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Extra" DROP COLUMN "wastageFactor",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lossRatio" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "RecipeFamily" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "RecipeVersion" DROP COLUMN "versionName",
ADD COLUMN     "name" TEXT NOT NULL,
ALTER COLUMN "versionNumber" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_recipeFamilyId_versionNumber_key" ON "RecipeVersion"("recipeFamilyId", "versionNumber");
