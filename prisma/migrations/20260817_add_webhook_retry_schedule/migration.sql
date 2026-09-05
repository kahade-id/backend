-- Durable webhook retry scheduling metadata.
-- Additive only: existing webhook rows remain valid and unprocessed rows become immediately eligible.
ALTER TABLE "webhook_logs"
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextRetryAt" TIMESTAMP(3),
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);

CREATE INDEX "webhook_logs_source_isProcessed_nextRetryAt_idx"
  ON "webhook_logs"("source", "isProcessed", "nextRetryAt");

CREATE INDEX "webhook_logs_deadLetteredAt_idx"
  ON "webhook_logs"("deadLetteredAt");
