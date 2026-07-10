-- CreateEnum
CREATE TYPE "RecipeImportJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "RecipeImportJob" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "status" "RecipeImportJobStatus" NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT,
    "mimeType" TEXT,
    "sourceData" BYTEA,
    "sourceText" TEXT,
    "catalogContext" TEXT NOT NULL,
    "result" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipeImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipeImportJob_tenantId_createdAt_idx" ON "RecipeImportJob"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RecipeImportJob_status_createdAt_idx" ON "RecipeImportJob"("status", "createdAt");
