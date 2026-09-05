-- AlterTable
ALTER TABLE "webhook_logs" ADD COLUMN "transactionId" TEXT;

-- CreateIndex
CREATE INDEX "webhook_logs_transactionId_idx" ON "webhook_logs"("transactionId");
