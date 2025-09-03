-- AlterTable
ALTER TABLE "ProductionTaskSpoilageLog" ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "ProductionTaskOverproductionLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionTaskOverproductionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionTaskOverproductionLog_productionLogId_idx" ON "ProductionTaskOverproductionLog"("productionLogId");

-- CreateIndex
CREATE INDEX "ProductionTaskOverproductionLog_productId_idx" ON "ProductionTaskOverproductionLog"("productId");

-- AddForeignKey
ALTER TABLE "ProductionTaskOverproductionLog" ADD CONSTRAINT "ProductionTaskOverproductionLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "ProductionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskOverproductionLog" ADD CONSTRAINT "ProductionTaskOverproductionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
