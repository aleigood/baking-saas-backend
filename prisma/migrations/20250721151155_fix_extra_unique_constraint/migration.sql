/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,name]` on the table `Extra` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Extra_tenantId_name_key" ON "Extra"("tenantId", "name");
