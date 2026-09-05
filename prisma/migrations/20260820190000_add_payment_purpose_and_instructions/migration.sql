-- Separate provider payments that fund a Kahade wallet from payments that fund an order escrow.
-- Existing rows are top-ups by definition and retain the TOPUP default.
CREATE TYPE "PaymentPurpose" AS ENUM ('TOPUP', 'ORDER_ESCROW');

ALTER TABLE "payment_transactions"
  ADD COLUMN "purpose" "PaymentPurpose" NOT NULL DEFAULT 'TOPUP',
  ADD COLUMN "providerInstructions" JSONB,
  ADD COLUMN "refundRequestedAt" TIMESTAMP(3),
  ADD COLUMN "refundReference" TEXT,
  ADD COLUMN "refundReason" TEXT;

CREATE INDEX "payment_transactions_purpose_status_idx"
  ON "payment_transactions"("purpose", "status");
