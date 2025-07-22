-- This is an empty migration.
-- 文件路径: prisma/migrations/xxxxxxxx_add-procedure-parent-constraint/migration.sql
-- 文件描述: [新增] 为 "Procedure" 表添加一个检查约束，确保它至少关联到一个父级（配方版本或产品）。

-- Add check constraint to the "Procedure" table
-- This ensures that either "recipeVersionId" or "productId" is not NULL, enforcing data integrity.
ALTER TABLE "Procedure"
ADD CONSTRAINT "procedure_has_parent_check"
CHECK ("recipeVersionId" IS NOT NULL OR "productId" IS NOT NULL);
