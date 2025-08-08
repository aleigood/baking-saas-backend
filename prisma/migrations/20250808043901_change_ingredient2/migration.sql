/*
  Warnings:

  - You are about to drop the column `isFlour` on the `DoughIngredient` table. All the data in the column will be lost.
  - You are about to drop the column `waterContent` on the `DoughIngredient` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "DoughIngredient" DROP COLUMN "isFlour",
DROP COLUMN "waterContent";
