-- Migration: Kahade+ benefit delta (2026-09-26).
--
-- 1. Enum SubscriptionPlan: ANNUAL -> YEARLY (spek Kahade+ memakai MONTHLY|YEARLY).
-- 2. Tabel subscription_usages: akumulasi fee yang dibebaskan per periode
--    billing (Benefit 1 — tanpa biaya transaksi, kuota Rp 990.000/periode).
-- 3. Tabel insurance_claims + enum InsuranceClaimStatus (Benefit 3 — asuransi).
--    Syarat & cap detail menyusul; field disiapkan di sini.
-- 4. Kolom support_tickets.priority (Benefit 4 — bantuan prioritas).
-- 5. Kolom user_showcases.descriptionHtml (Benefit 7 — custom etalase).

-- 1. Rename nilai enum ANNUAL -> YEARLY (PostgreSQL 10+).
ALTER TYPE "SubscriptionPlan" RENAME VALUE 'ANNUAL' TO 'YEARLY';

-- 2. Enum status klaim asuransi.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InsuranceClaimStatus') THEN
    CREATE TYPE "InsuranceClaimStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAID');
  END IF;
END
$$;

-- 3. Tabel pemakaian kuota fee per periode billing.
CREATE TABLE IF NOT EXISTS "subscription_usages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "subscriptionId" TEXT NOT NULL REFERENCES "subscriptions"("id") ON DELETE CASCADE,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "feeWaivedAmount" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_usages_subscriptionId_periodStart_key"
  ON "subscription_usages"("subscriptionId", "periodStart");
CREATE INDEX IF NOT EXISTS "subscription_usages_subscriptionId_idx"
  ON "subscription_usages"("subscriptionId");

-- 4. Tabel klaim asuransi.
CREATE TABLE IF NOT EXISTS "insurance_claims" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "orderId" TEXT,
  "claimType" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "cap" BIGINT NOT NULL,
  "status" "InsuranceClaimStatus" NOT NULL DEFAULT 'DRAFT',
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "insurance_claims_userId_idx" ON "insurance_claims"("userId");
CREATE INDEX IF NOT EXISTS "insurance_claims_status_idx" ON "insurance_claims"("status");
CREATE INDEX IF NOT EXISTS "insurance_claims_userId_status_idx" ON "insurance_claims"("userId", "status");

-- 5. Flag prioritas tiket support.
ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "priority" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "support_tickets_priority_idx" ON "support_tickets"("priority");

-- 6. Deskripsi HTML etalase untuk subscriber.
ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "descriptionHtml" TEXT;
