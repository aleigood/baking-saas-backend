-- AlterTable
ALTER TABLE "Procedure" ADD COLUMN     "doughId" TEXT,
ADD COLUMN     "extraId" TEXT;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_doughId_fkey" FOREIGN KEY ("doughId") REFERENCES "Dough"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Procedure" ADD CONSTRAINT "Procedure_extraId_fkey" FOREIGN KEY ("extraId") REFERENCES "Extra"("id") ON DELETE SET NULL ON UPDATE CASCADE;
