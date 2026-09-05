-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('INFORMASI', 'PROMOSI', 'TRANSAKSI');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "category" "NotificationCategory" NOT NULL DEFAULT 'INFORMASI';

-- CreateIndex
CREATE INDEX "notifications_userId_category_isRead_idx" ON "notifications"("userId", "category", "isRead");
