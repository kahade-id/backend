-- Promo Kahade system: campaign targeting, personal vouchers, cashback/top-up bonus,
-- referral review flags, and subscription trial/pause support.

-- ═══════════════════════════════════════════════════════════════════════════
-- Enum extensions (idempotent for dev/test replays)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  ALTER TYPE "WalletTransactionType" ADD VALUE 'CAMPAIGN_CASHBACK';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "WalletTransactionType" ADD VALUE 'TOPUP_BONUS';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "SubscriptionStatus" ADD VALUE 'PAUSED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'VOUCHER_ISSUED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'CAMPAIGN_CASHBACK_CREDITED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "NotificationType" ADD VALUE 'TOPUP_BONUS_CREDITED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "VoucherType" ADD VALUE 'WALLET_CASHBACK';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "VoucherType" ADD VALUE 'TOPUP_BONUS';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "VoucherApplicability" ADD VALUE 'DORMANT_USER';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Columns
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "membershipRankDiscount" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "vouchers"
  ADD COLUMN IF NOT EXISTS "campaignId" TEXT,
  ADD COLUMN IF NOT EXISTS "assignedToUserId" TEXT;

ALTER TABLE "voucher_usages"
  ALTER COLUMN "orderId" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "paymentTxId" TEXT;

ALTER TABLE "referral_relations"
  ADD COLUMN IF NOT EXISTS "flaggedForReview" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "flaggedForReviewAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewReason" TEXT;

ALTER TABLE "subscriptions"
  ADD COLUMN IF NOT EXISTS "originalPrice" BIGINT,
  ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "pausedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resumeAt" TIMESTAMP(3);

ALTER TABLE "campaigns"
  ADD COLUMN IF NOT EXISTS "targetMinRank" "MembershipRank",
  ADD COLUMN IF NOT EXISTS "targetDormantDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "targetNewUserOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "promoCode" TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Foreign keys
-- ═══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vouchers_campaignId_fkey') THEN
    ALTER TABLE "vouchers"
      ADD CONSTRAINT "vouchers_campaignId_fkey"
      FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_usages_paymentTxId_fkey') THEN
    ALTER TABLE "voucher_usages"
      ADD CONSTRAINT "voucher_usages_paymentTxId_fkey"
      FOREIGN KEY ("paymentTxId") REFERENCES "payment_transactions"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Checks
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "vouchers" DROP CONSTRAINT IF EXISTS "voucher_discount_xor";
ALTER TABLE "vouchers" ADD CONSTRAINT "voucher_discount_xor"
  CHECK (
    ("voucherType" = 'FEE_DISCOUNT_FLAT' AND "discountAmount" IS NOT NULL AND "discountPercent" IS NULL) OR
    ("voucherType" = 'FEE_DISCOUNT_PERCENT' AND "discountPercent" IS NOT NULL AND "discountAmount" IS NULL) OR
    (
      "voucherType" IN ('WALLET_CASHBACK', 'TOPUP_BONUS') AND (
        ("discountAmount" IS NOT NULL AND "discountPercent" IS NULL) OR
        ("discountAmount" IS NULL AND "discountPercent" IS NOT NULL)
      )
    )
  );

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_usage_context_xor') THEN
    ALTER TABLE "voucher_usages" ADD CONSTRAINT "voucher_usage_context_xor"
      CHECK (("orderId" IS NOT NULL AND "paymentTxId" IS NULL) OR ("orderId" IS NULL AND "paymentTxId" IS NOT NULL));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_membership_rank_discount_non_negative') THEN
    ALTER TABLE "orders" ADD CONSTRAINT "order_membership_rank_discount_non_negative"
      CHECK ("membershipRankDiscount" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_rollout_percent_valid') THEN
    ALTER TABLE "campaigns" ADD CONSTRAINT "campaign_rollout_percent_valid"
      CHECK ("rolloutPercent" IS NULL OR ("rolloutPercent" >= 0 AND "rolloutPercent" <= 100));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'campaign_target_dormant_days_positive') THEN
    ALTER TABLE "campaigns" ADD CONSTRAINT "campaign_target_dormant_days_positive"
      CHECK ("targetDormantDays" IS NULL OR "targetDormantDays" > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_trial_period_valid') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscription_trial_period_valid"
      CHECK ("trialEndsAt" IS NULL OR "currentPeriodEnd" = "trialEndsAt");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_pause_resume_valid') THEN
    ALTER TABLE "subscriptions" ADD CONSTRAINT "subscription_pause_resume_valid"
      CHECK ("resumeAt" IS NULL OR "pausedAt" IS NOT NULL);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Indexes
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS "vouchers_campaignId_idx" ON "vouchers"("campaignId");
CREATE INDEX IF NOT EXISTS "vouchers_assignedToUserId_isActive_validUntil_idx" ON "vouchers"("assignedToUserId", "isActive", "validUntil");
CREATE UNIQUE INDEX IF NOT EXISTS "vouchers_campaignId_assignedToUserId_key" ON "vouchers"("campaignId", "assignedToUserId");

CREATE INDEX IF NOT EXISTS "voucher_usages_paymentTxId_idx" ON "voucher_usages"("paymentTxId");
CREATE UNIQUE INDEX IF NOT EXISTS "voucher_usages_voucherId_userId_paymentTxId_key" ON "voucher_usages"("voucherId", "userId", "paymentTxId");

CREATE INDEX IF NOT EXISTS "referral_relations_referrerId_appliedAt_idx" ON "referral_relations"("referrerId", "appliedAt");
CREATE INDEX IF NOT EXISTS "referral_relations_flaggedForReview_idx" ON "referral_relations"("flaggedForReview");

CREATE INDEX IF NOT EXISTS "subscriptions_status_resumeAt_idx" ON "subscriptions"("status", "resumeAt");
CREATE INDEX IF NOT EXISTS "subscriptions_userId_trialEndsAt_idx" ON "subscriptions"("userId", "trialEndsAt");

CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_promoCode_key" ON "campaigns"("promoCode");
CREATE INDEX IF NOT EXISTS "campaigns_targetMinRank_idx" ON "campaigns"("targetMinRank");
CREATE INDEX IF NOT EXISTS "campaigns_promoCode_idx" ON "campaigns"("promoCode");
