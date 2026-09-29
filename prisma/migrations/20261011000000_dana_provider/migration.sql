-- DANA Enterprise (Gapura) — additive-only.
-- 1. Tambah enum value PaymentProvider.DANA
-- 2. Tambah kolom referensi order DANA di payment_transactions
--    (danaPartnerReferenceNo = partnerReferenceNo Create Order = kunci idempotency DANA)
-- CATATAN: nama tabel fisik "payment_transactions" (model PaymentTransaction pakai @@map).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DANA'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PaymentProvider')) THEN
    ALTER TYPE "PaymentProvider" ADD VALUE 'DANA';
  END IF;
END $$;

ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "danaPartnerReferenceNo" TEXT;
ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "danaReferenceNo" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'payment_transactions_danaPartnerReferenceNo_key') THEN
    CREATE UNIQUE INDEX "payment_transactions_danaPartnerReferenceNo_key"
      ON "payment_transactions"("danaPartnerReferenceNo");
  END IF;
END $$;
