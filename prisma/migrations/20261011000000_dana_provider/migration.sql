-- DANA Enterprise (Gapura) — additive-only.
-- 1. Tambah enum value PaymentProvider.DANA
-- 2. Tambah kolom referensi order DANA di PaymentTransaction
--    (danaPartnerReferenceNo = partnerReferenceNo Create Order = kunci idempotency DANA)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DANA'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'PaymentProvider')) THEN
    ALTER TYPE "PaymentProvider" ADD VALUE 'DANA';
  END IF;
END $$;

ALTER TABLE "PaymentTransaction" ADD COLUMN IF NOT EXISTS "danaPartnerReferenceNo" TEXT;
ALTER TABLE "PaymentTransaction" ADD COLUMN IF NOT EXISTS "danaReferenceNo" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'PaymentTransaction_danaPartnerReferenceNo_key') THEN
    CREATE UNIQUE INDEX "PaymentTransaction_danaPartnerReferenceNo_key"
      ON "PaymentTransaction"("danaPartnerReferenceNo");
  END IF;
END $$;
