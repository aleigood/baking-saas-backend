ALTER TABLE "RecipeImportJob"
    ADD COLUMN "diagnosticData" JSONB,
    ADD COLUMN "diagnosticExpiresAt" TIMESTAMP(3);

ALTER TABLE "RecipeImportJob"
    ADD CONSTRAINT "RecipeImportJob_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "RecipeImportJob_diagnosticExpiresAt_idx"
    ON "RecipeImportJob"("diagnosticExpiresAt");
