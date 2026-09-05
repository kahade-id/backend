-- Track the cumulative provider-confirmed refund in ledger units (IDR sen).
-- This makes repeated partial_refund webhooks replay-safe without treating the
-- first partial refund as a reversal of the whole top-up.
ALTER TABLE "payment_transactions"
  ADD COLUMN IF NOT EXISTS "refundedAmount" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "payment_transactions"
  ADD CONSTRAINT "payment_transactions_refunded_amount_non_negative"
  CHECK ("refundedAmount" >= 0);
