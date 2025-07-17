-- CreateEnum
CREATE TYPE "IngredientType" AS ENUM ('STANDARD', 'UNTRACKED');

-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "type" "IngredientType" NOT NULL DEFAULT 'STANDARD';
