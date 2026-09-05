-- Durable idempotency ledger and webhook inbox.
-- This migration is intentionally additive and does not alter existing transaction rows.

CREATE TYPE "IdempotencyRecordStatus" AS ENUM ('IN_FLIGHT', 'COMPLETED');

CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "key" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "status" "IdempotencyRecordStatus" NOT NULL DEFAULT 'IN_FLIGHT',
    "responseBody" JSONB,
    "statusCode" INTEGER NOT NULL DEFAULT 200,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "idempotency_records"
  ADD CONSTRAINT "idempotency_records_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "idempotency_records_scopeKey_key" ON "idempotency_records"("scopeKey");
CREATE INDEX "idempotency_records_userId_key_idx" ON "idempotency_records"("userId", "key");
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");
CREATE INDEX "idempotency_records_status_expiresAt_idx" ON "idempotency_records"("status", "expiresAt");

ALTER TABLE "webhook_logs" ADD COLUMN "eventKey" TEXT;
CREATE UNIQUE INDEX "webhook_logs_eventKey_key" ON "webhook_logs"("eventKey");
