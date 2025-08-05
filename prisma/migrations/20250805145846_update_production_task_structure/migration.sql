/*
  Warnings:

  - You are about to drop the column `actualQuantity` on the `ProductionLog` table. All the data in the column will be lost.
  - You are about to drop the column `productId` on the `ProductionTask` table. All the data in the column will be lost.
  - You are about to drop the column `quantity` on the `ProductionTask` table. All the data in the column will be lost.
  - You are about to drop the column `unit` on the `ProductionTask` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "ProductionTask" DROP CONSTRAINT "ProductionTask_productId_fkey";

-- DropIndex
DROP INDEX "ProductionTask_productId_idx";

-- AlterTable
ALTER TABLE "ProductionLog" DROP COLUMN "actualQuantity";

-- AlterTable
ALTER TABLE "ProductionTask" DROP COLUMN "productId",
DROP COLUMN "quantity",
DROP COLUMN "unit",
ADD COLUMN     "name" TEXT;

-- CreateTable
CREATE TABLE "ProductionTaskItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ProductionTaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionTaskItem_taskId_idx" ON "ProductionTaskItem"("taskId");

-- CreateIndex
CREATE INDEX "ProductionTaskItem_productId_idx" ON "ProductionTaskItem"("productId");

-- AddForeignKey
ALTER TABLE "ProductionTaskItem" ADD CONSTRAINT "ProductionTaskItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ProductionTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskItem" ADD CONSTRAINT "ProductionTaskItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
