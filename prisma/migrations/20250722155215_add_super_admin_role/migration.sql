-- CreateEnum
CREATE TYPE "SystemRole" AS ENUM ('SUPER_ADMIN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "systemRole" "SystemRole";
