-- Bind durable idempotency records to the canonical request payload.
ALTER TABLE "idempotency_records"
  ADD COLUMN "requestHash" TEXT;
