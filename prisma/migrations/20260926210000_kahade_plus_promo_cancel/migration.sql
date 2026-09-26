-- Kahade+ revisi keputusan produk 2026-09-26:
-- 1. cancelAtPeriodEnd pada subscriptions (cancel sampai akhir periode).
-- 2. Tabel subscription_promo_codes (kode promo gratis dikelola admin).

ALTER TABLE "subscriptions" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "SubscriptionPromoCodeStatus" AS ENUM ('ACTIVE', 'DISABLED');

CREATE TABLE "subscription_promo_codes" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "maxRedemptions" INTEGER DEFAULT 1,
  "currentRedemptions" INTEGER NOT NULL DEFAULT 0,
  "assignedUserId" TEXT,
  "status" "SubscriptionPromoCodeStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "subscription_promo_codes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "subscription_promo_codes"
  ADD CONSTRAINT "subscription_promo_codes_assignedUserId_fkey"
  FOREIGN KEY ("assignedUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "subscription_promo_codes_code_key" ON "subscription_promo_codes"("code");
CREATE INDEX "subscription_promo_codes_status_idx" ON "subscription_promo_codes"("status");
CREATE INDEX "subscription_promo_codes_assignedUserId_idx" ON "subscription_promo_codes"("assignedUserId");

-- Kolom audit kode promo yang dipakai saat subscribe.
ALTER TABLE "subscriptions" ADD COLUMN "promoCodeUsed" TEXT;

-- Trial dihapus (keputusan produk 2026-09-26): drop kolom + index.
DROP INDEX IF EXISTS "subscriptions_userId_trialEndsAt_idx";
ALTER TABLE "subscriptions" DROP COLUMN "trialEndsAt";

-- Flash Mobile (MNC) sebagai payment gateway QRIS pengganti Midtrans.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'FLASH';
ALTER TYPE "PaymentPurpose" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION';
ALTER TABLE "payment_transactions" ADD COLUMN "flashTransactionId" TEXT;
ALTER TABLE "payment_transactions" ADD COLUMN "flashQrString" TEXT;
