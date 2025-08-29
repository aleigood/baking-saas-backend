-- CreateTable
CREATE TABLE "ProductionTaskSpoilageLog" (
    "id" TEXT NOT NULL,
    "productionLogId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionTaskSpoilageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductionTaskSpoilageLog_productionLogId_idx" ON "ProductionTaskSpoilageLog"("productionLogId");

-- CreateIndex
CREATE INDEX "ProductionTaskSpoilageLog_productId_idx" ON "ProductionTaskSpoilageLog"("productId");

-- AddForeignKey
ALTER TABLE "ProductionTaskSpoilageLog" ADD CONSTRAINT "ProductionTaskSpoilageLog_productionLogId_fkey" FOREIGN KEY ("productionLogId") REFERENCES "ProductionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionTaskSpoilageLog" ADD CONSTRAINT "ProductionTaskSpoilageLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
