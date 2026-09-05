-- Security Audit: Add missing CHECK constraints documented in schema.prisma
-- Column names use "camelCase" (Prisma default — no @map overrides)
-- Uses IF NOT EXISTS guard so constraints are idempotent (safe to re-run)

-- ═══════════════════════════════════════════════════════════════════════════
-- Voucher constraints
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_discount_xor') THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_discount_xor
      CHECK (
        ("voucherType" = 'FEE_DISCOUNT_FLAT'    AND "discountAmount" IS NOT NULL AND "discountPercent" IS NULL) OR
        ("voucherType" = 'FEE_DISCOUNT_PERCENT' AND "discountPercent" IS NOT NULL AND "discountAmount" IS NULL)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_discount_percent_range') THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_discount_percent_range
      CHECK ("discountPercent" IS NULL OR ("discountPercent" > 0 AND "discountPercent" <= 100));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_validity_range') THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_validity_range
      CHECK ("validUntil" > "validFrom");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_usage_per_user_valid') THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_usage_per_user_valid
      CHECK ("maxUsagePerUser" >= 1);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Referral constraints
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_no_self') THEN
    ALTER TABLE referral_relations ADD CONSTRAINT referral_no_self
      CHECK ("referrerId" != "refereeId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referral_code_counters_non_negative') THEN
    ALTER TABLE referral_codes ADD CONSTRAINT referral_code_counters_non_negative
      CHECK ("totalReferrals" >= 0 AND "totalRewardEarned" >= 0);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Dispute evidence constraints
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_submitter_xor') THEN
    ALTER TABLE dispute_evidences ADD CONSTRAINT evidence_submitter_xor
      CHECK (
        ("submittedByRole" IN ('BUYER', 'SELLER') AND "submittedByUserId" IS NOT NULL AND "submittedByAdminId" IS NULL) OR
        ("submittedByRole" = 'ADMIN'              AND "submittedByAdminId" IS NOT NULL AND "submittedByUserId" IS NULL) OR
        ("submittedByRole" = 'SYSTEM'             AND "submittedByUserId" IS NULL      AND "submittedByAdminId" IS NULL)
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'evidence_files_length') THEN
    ALTER TABLE dispute_evidences ADD CONSTRAINT evidence_files_length
      CHECK (array_length("fileUrls", 1) = array_length("fileTypes", 1));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Block list constraint
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'block_no_self') THEN
    ALTER TABLE block_lists ADD CONSTRAINT block_no_self
      CHECK ("blockerId" != "blockedId");
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Subscription constraints
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_period_valid') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscription_period_valid
      CHECK (
        ("currentPeriodStart" IS NULL AND "currentPeriodEnd" IS NULL) OR
        ("currentPeriodEnd" > "currentPeriodStart")
      );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscription_savings_valid') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscription_savings_valid
      CHECK ("feeSavingsUsed" >= 0 AND "feeSavingsLimit" >= 0
        AND "feeSavingsUsed" <= "feeSavingsLimit");
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Membership rank history constraint
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'avg_rating_range') THEN
    ALTER TABLE membership_rank_histories ADD CONSTRAINT avg_rating_range
      CHECK ("averageRating" BETWEEN 0 AND 5);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Bank account partial unique index (Iris)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS bank_iris_account_unique
  ON bank_accounts("irisAccountId")
  WHERE "irisAccountId" IS NOT NULL;

-- NOTE: wallet_balance_equality (totalBalance = availableBalance + escrowBalance)
-- is intentionally NOT added. The schema documents that this invariant is
-- temporarily violated during the PENDING_OTP withdrawal window where
-- availableBalance is held but totalBalance is not yet reduced.
