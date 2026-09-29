-- Misi "Mode Tanpa Wallet Internal (BI-safe)" — ADDITIVE ONLY.
-- 1. Kolom referensi DANA di orders (escrow didanai langsung via DANA).
-- 2. Kolom danaPayKind di payment_transactions (metode bayar DANA direct).
-- 3. Tabel baru escrow_disbursements: disbursement escrow LANGSUNG ke
--    rekening bank seller via DANA Disbursement (bukan kredit wallet).
-- Gaya idempoten (IF NOT EXISTS) mengikuti migrasi DANA sebelumnya.

-- 1. orders: referensi DANA (aditif, nullable)
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "danaPartnerReferenceNo" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "danaReferenceNo" TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'orders_danaPartnerReferenceNo_key') THEN
    CREATE UNIQUE INDEX "orders_danaPartnerReferenceNo_key"
      ON "orders"("danaPartnerReferenceNo");
  END IF;
END $$;

-- 2. payment_transactions: metode bayar DANA direct (aditif, nullable)
ALTER TABLE "payment_transactions" ADD COLUMN IF NOT EXISTS "danaPayKind" TEXT;

-- 3. Enum baru untuk escrow_disbursements
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EscrowDisbursementScope') THEN
    CREATE TYPE "EscrowDisbursementScope" AS ENUM ('ORDER_ESCROW', 'MILESTONE', 'LEGACY_WALLET_PAYOUT');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EscrowDisbursementStatus') THEN
    CREATE TYPE "EscrowDisbursementStatus" AS ENUM ('PENDING', 'HELD_NO_BANK', 'PROCESSING', 'SUCCESS', 'FAILED');
  END IF;
END $$;

-- 4. Tabel escrow_disbursements
CREATE TABLE IF NOT EXISTS "escrow_disbursements" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "scope" "EscrowDisbursementScope" NOT NULL,
    "scopeRefId" TEXT,
    "orderId" TEXT,
    "sellerId" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "amountSen" BIGINT NOT NULL,
    "status" "EscrowDisbursementStatus" NOT NULL DEFAULT 'PENDING',
    "danaPartnerReferenceNo" TEXT,
    "danaReferenceNo" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "heldReason" TEXT,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "escrow_disbursements_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'escrow_disbursements_idempotencyKey_key') THEN
    CREATE UNIQUE INDEX "escrow_disbursements_idempotencyKey_key"
      ON "escrow_disbursements"("idempotencyKey");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'escrow_disbursements_danaPartnerReferenceNo_key') THEN
    CREATE UNIQUE INDEX "escrow_disbursements_danaPartnerReferenceNo_key"
      ON "escrow_disbursements"("danaPartnerReferenceNo");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'escrow_disbursements_sellerId_status_idx') THEN
    CREATE INDEX "escrow_disbursements_sellerId_status_idx"
      ON "escrow_disbursements"("sellerId", "status");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'escrow_disbursements_orderId_idx') THEN
    CREATE INDEX "escrow_disbursements_orderId_idx"
      ON "escrow_disbursements"("orderId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
    WHERE indexname = 'escrow_disbursements_status_idx') THEN
    CREATE INDEX "escrow_disbursements_status_idx"
      ON "escrow_disbursements"("status");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'escrow_disbursements_sellerId_fkey') THEN
    ALTER TABLE "escrow_disbursements" ADD CONSTRAINT "escrow_disbursements_sellerId_fkey"
      FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'escrow_disbursements_bankAccountId_fkey') THEN
    ALTER TABLE "escrow_disbursements" ADD CONSTRAINT "escrow_disbursements_bankAccountId_fkey"
      FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
