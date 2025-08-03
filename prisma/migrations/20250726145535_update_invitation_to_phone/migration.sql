/*
  Warnings:

  - You are about to drop the column `email` on the `Invitation` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[tenantId,phone]` on the table `Invitation` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `phone` to the `Invitation` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Invitation_tenantId_email_key";

-- AlterTable
ALTER TABLE "Invitation" DROP COLUMN "email",
ADD COLUMN     "phone" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tenantId_phone_key" ON "Invitation"("tenantId", "phone");
