#!/usr/bin/env bash
# Implement DB-level CHECK constraints documented in schema.prisma.
# Applied AFTER prisma migrate so Prisma doesn't interfere with custom constraints.
# Script is idempotent — uses IF NOT EXISTS / DO NOTHING patterns.
#
# IMPORTANT: Prisma uses camelCase column names (no @map on columns).
# All column names MUST be double-quoted in SQL.
set -euo pipefail

DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "ERROR: DATABASE_URL environment variable is not set."
  exit 1
fi

DB_URL=$(echo "$DB_URL" | sed -E 's/[?&](connection_limit|pool_timeout|connect_timeout|statement_cache_size|pgbouncer|sslaccept|socket_timeout)=[^&]*//g' | sed 's/?&/?/' | sed 's/\?$//')

echo "Applying Kahade DB constraints..."

# INF-12: `-v ON_ERROR_STOP=1` is mandatory here.
#
# Without it, psql in script mode reports a failed statement, continues to the next
# one, and still exits 0 — so `set -e` never fires and the final
# "All constraints applied successfully" printed below is unconditional. A fresh
# production DB could come up missing `wallet_balance_invariant`, `order_fee_sum`,
# or any other money invariant while the deploy log reported success. These CHECKs
# are the last line of defence behind the escrow accounting, so a silent skip is
# the worst possible failure mode.
#
# `--single-transaction` makes the batch atomic: a partial application rolls back
# rather than leaving the DB half-constrained. Every statement here is either a
# DO block or a non-CONCURRENT CREATE INDEX, both of which are transaction-safe.
psql -v ON_ERROR_STOP=1 --single-transaction "$DB_URL" << 'SQL'

-- Serialize constraint installation across concurrently starting containers.
-- The xact-scoped lock is held until the surrounding --single-transaction
-- commits or rolls back.
SELECT pg_advisory_xact_lock(202603211);

-- ============================================================
-- WALLET CONSTRAINTS
-- ============================================================

-- 1. Wallet balances must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallet_balances_non_negative'
  ) THEN
    ALTER TABLE wallets ADD CONSTRAINT wallet_balances_non_negative
      CHECK ("availableBalance" >= 0 AND "escrowBalance" >= 0 AND "totalBalance" >= 0);
    RAISE NOTICE 'Added: wallet_balances_non_negative';
  ELSE
    RAISE NOTICE 'Exists: wallet_balances_non_negative';
  END IF;
END $$;

-- 1b. Wallet balance invariant: totalBalance = availableBalance + escrowBalance
-- Uses NOT VALID to avoid full table scan on large datasets; validated separately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallet_balance_invariant'
  ) THEN
    ALTER TABLE wallets ADD CONSTRAINT wallet_balance_invariant
      CHECK ("totalBalance" = "availableBalance" + "escrowBalance") NOT VALID;
    ALTER TABLE wallets VALIDATE CONSTRAINT wallet_balance_invariant;
    RAISE NOTICE 'Added: wallet_balance_invariant';
  ELSE
    RAISE NOTICE 'Exists: wallet_balance_invariant';
  END IF;
END $$;

-- ============================================================
-- VOUCHER CONSTRAINTS
-- ============================================================

-- 2. Voucher type/amount exclusivity
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'voucher_type_amount_exclusive'
  ) THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_type_amount_exclusive
      CHECK (
        ("voucherType" = 'FEE_DISCOUNT_FLAT'    AND "discountAmount" IS NOT NULL AND "discountPercent" IS NULL) OR
        ("voucherType" = 'FEE_DISCOUNT_PERCENT' AND "discountPercent" IS NOT NULL AND "discountAmount" IS NULL)
      );
    RAISE NOTICE 'Added: voucher_type_amount_exclusive';
  ELSE
    RAISE NOTICE 'Exists: voucher_type_amount_exclusive';
  END IF;
END $$;

-- 2b. Voucher percent must be between 0 and 100
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'voucher_percent_range'
  ) THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_percent_range
      CHECK ("discountPercent" IS NULL OR ("discountPercent" > 0 AND "discountPercent" <= 100));
    RAISE NOTICE 'Added: voucher_percent_range';
  ELSE
    RAISE NOTICE 'Exists: voucher_percent_range';
  END IF;
END $$;

-- 2c. Voucher max_usage_per_user must be >= 1
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'voucher_usage_per_user_valid'
  ) THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_usage_per_user_valid
      CHECK ("maxUsagePerUser" >= 1);
    RAISE NOTICE 'Added: voucher_usage_per_user_valid';
  ELSE
    RAISE NOTICE 'Exists: voucher_usage_per_user_valid';
  END IF;
END $$;

-- 2d. Voucher validity range: validUntil > validFrom
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'voucher_validity_range'
  ) THEN
    ALTER TABLE vouchers ADD CONSTRAINT voucher_validity_range
      CHECK ("validUntil" > "validFrom");
    RAISE NOTICE 'Added: voucher_validity_range';
  ELSE
    RAISE NOTICE 'Exists: voucher_validity_range';
  END IF;
END $$;

-- ============================================================
-- DISPUTE CONSTRAINTS
-- ============================================================

-- 3. Dispute SPLIT percentages must sum to 100
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'dispute_split_percent_sum'
  ) THEN
    ALTER TABLE dispute_decisions ADD CONSTRAINT dispute_split_percent_sum
      CHECK (
        "decisionType" != 'SPLIT' OR
        ("buyerPercent" IS NOT NULL AND "sellerPercent" IS NOT NULL AND "buyerPercent" + "sellerPercent" = 100)
      );
    RAISE NOTICE 'Added: dispute_split_percent_sum';
  ELSE
    RAISE NOTICE 'Exists: dispute_split_percent_sum';
  END IF;
END $$;

-- 3b. Dispute decision amounts must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'decision_amounts_non_negative'
  ) THEN
    ALTER TABLE dispute_decisions ADD CONSTRAINT decision_amounts_non_negative
      CHECK ("buyerAmount" >= 0 AND "sellerAmount" >= 0);
    RAISE NOTICE 'Added: decision_amounts_non_negative';
  ELSE
    RAISE NOTICE 'Exists: decision_amounts_non_negative';
  END IF;
END $$;

-- 3c. Dispute split buyer percent range (0-100)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'split_buyer_percent_range'
  ) THEN
    ALTER TABLE dispute_decisions ADD CONSTRAINT split_buyer_percent_range
      CHECK ("buyerPercent" IS NULL OR ("buyerPercent" BETWEEN 0 AND 100));
    RAISE NOTICE 'Added: split_buyer_percent_range';
  ELSE
    RAISE NOTICE 'Exists: split_buyer_percent_range';
  END IF;
END $$;

-- 3d. Dispute split seller percent range (0-100)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'split_seller_percent_range'
  ) THEN
    ALTER TABLE dispute_decisions ADD CONSTRAINT split_seller_percent_range
      CHECK ("sellerPercent" IS NULL OR ("sellerPercent" BETWEEN 0 AND 100));
    RAISE NOTICE 'Added: split_seller_percent_range';
  ELSE
    RAISE NOTICE 'Exists: split_seller_percent_range';
  END IF;
END $$;

-- 3e. Dispute SLA hours must be positive
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'dispute_sla_hours_positive'
  ) THEN
    ALTER TABLE disputes ADD CONSTRAINT dispute_sla_hours_positive
      CHECK ("slaHours" IS NULL OR "slaHours" > 0);
    RAISE NOTICE 'Added: dispute_sla_hours_positive';
  ELSE
    RAISE NOTICE 'Exists: dispute_sla_hours_positive';
  END IF;
END $$;

-- ============================================================
-- ORDER CONSTRAINTS
-- ============================================================

-- 4. Order financial invariant
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'order_amounts_non_negative'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT order_amounts_non_negative
      CHECK (
        "buyerPayAmount" >= 0 AND
        "sellerReceiveAmount" >= 0 AND
        "feeAmount" >= 0 AND
        "buyerPayAmount" >= "sellerReceiveAmount"
      );
    RAISE NOTICE 'Added: order_amounts_non_negative';
  ELSE
    RAISE NOTICE 'Exists: order_amounts_non_negative';
  END IF;
END $$;

-- 5. Order value must be positive
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'order_value_positive'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT order_value_positive
      CHECK ("orderValue" > 0);
    RAISE NOTICE 'Added: order_value_positive';
  ELSE
    RAISE NOTICE 'Exists: order_value_positive';
  END IF;
END $$;

-- ============================================================
-- RATING CONSTRAINTS
-- ============================================================

-- 7. Rating stars must be between 1 and 5
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'rating_stars_range'
  ) THEN
    ALTER TABLE ratings ADD CONSTRAINT rating_stars_range
      CHECK (stars BETWEEN 1 AND 5);
    RAISE NOTICE 'Added: rating_stars_range';
  ELSE
    RAISE NOTICE 'Exists: rating_stars_range';
  END IF;
END $$;

-- ============================================================
-- EXTENSION REQUEST CONSTRAINTS
-- ============================================================

-- 8. Extension days must be between 1 and 14
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'extension_days_range'
  ) THEN
    ALTER TABLE order_extension_requests ADD CONSTRAINT extension_days_range
      CHECK ("extensionDays" BETWEEN 1 AND 14);
    RAISE NOTICE 'Added: extension_days_range';
  ELSE
    RAISE NOTICE 'Exists: extension_days_range';
  END IF;
END $$;

-- ============================================================
-- REFERRAL CONSTRAINTS
-- ============================================================

-- 9. No self-referral
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'referral_no_self'
  ) THEN
    ALTER TABLE referral_relations ADD CONSTRAINT referral_no_self
      CHECK ("referrerId" != "refereeId");
    RAISE NOTICE 'Added: referral_no_self';
  ELSE
    RAISE NOTICE 'Exists: referral_no_self';
  END IF;
END $$;

-- 9b. Referral counters must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'referral_code_counters_non_negative'
  ) THEN
    ALTER TABLE referral_codes ADD CONSTRAINT referral_code_counters_non_negative
      CHECK ("totalReferrals" >= 0 AND "totalRewardEarned" >= 0);
    RAISE NOTICE 'Added: referral_code_counters_non_negative';
  ELSE
    RAISE NOTICE 'Exists: referral_code_counters_non_negative';
  END IF;
END $$;

-- ============================================================
-- USER CONSTRAINTS
-- ============================================================

-- 10. User stats must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'user_stats_non_negative'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT user_stats_non_negative
      CHECK (
        "totalOrdersCompleted" >= 0 AND
        "totalOrdersAsBuyer" >= 0 AND
        "totalOrdersAsSeller" >= 0 AND
        "totalOrdersCancelled" >= 0 AND
        "totalOrdersDisputed" >= 0 AND
        "totalTransactionValue" >= 0 AND
        "averageRating" >= 0 AND "averageRating" <= 5 AND
        "totalRatingCount" >= 0
      );
    RAISE NOTICE 'Added: user_stats_non_negative';
  ELSE
    RAISE NOTICE 'Exists: user_stats_non_negative';
  END IF;
END $$;

-- 10b. Failed login attempts must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'user_failed_login_non_negative'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT user_failed_login_non_negative
      CHECK ("failedLoginAttempts" >= 0);
    RAISE NOTICE 'Added: user_failed_login_non_negative';
  ELSE
    RAISE NOTICE 'Exists: user_failed_login_non_negative';
  END IF;
END $$;

-- ============================================================
-- SUBSCRIPTION CONSTRAINTS
-- ============================================================

-- 11. Subscription period validity
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'subscription_period_valid'
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscription_period_valid
      CHECK (
        ("currentPeriodStart" IS NULL AND "currentPeriodEnd" IS NULL) OR
        ("currentPeriodEnd" > "currentPeriodStart")
      );
    RAISE NOTICE 'Added: subscription_period_valid';
  ELSE
    RAISE NOTICE 'Exists: subscription_period_valid';
  END IF;
END $$;

-- ============================================================
-- OTP / DEVICE CONSTRAINTS
-- ============================================================

-- 12. OTP attempts must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'otp_attempts_non_negative'
  ) THEN
    ALTER TABLE otp_codes ADD CONSTRAINT otp_attempts_non_negative
      CHECK (attempts >= 0);
    RAISE NOTICE 'Added: otp_attempts_non_negative';
  ELSE
    RAISE NOTICE 'Exists: otp_attempts_non_negative';
  END IF;
END $$;

-- 13. Device login count must be non-negative
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'device_login_count_non_negative'
  ) THEN
    ALTER TABLE user_devices ADD CONSTRAINT device_login_count_non_negative
      CHECK ("loginCount" >= 0);
    RAISE NOTICE 'Added: device_login_count_non_negative';
  ELSE
    RAISE NOTICE 'Exists: device_login_count_non_negative';
  END IF;
END $$;

-- ============================================================
-- PARTIAL UNIQUE INDEXES
-- ============================================================

-- 14. Only one PENDING KYC request per user
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'kyc_one_pending_per_user'
  ) THEN
    CREATE UNIQUE INDEX kyc_one_pending_per_user
      ON kyc_requests("userId")
      WHERE status = 'PENDING';
    RAISE NOTICE 'Added: kyc_one_pending_per_user';
  ELSE
    RAISE NOTICE 'Exists: kyc_one_pending_per_user';
  END IF;
END $$;

-- 15. Only one primary bank account per user (among non-deleted)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'bank_one_primary_per_user'
  ) THEN
    CREATE UNIQUE INDEX bank_one_primary_per_user
      ON bank_accounts("userId")
      WHERE "isPrimary" = true AND "deletedAt" IS NULL;
    RAISE NOTICE 'Added: bank_one_primary_per_user';
  ELSE
    RAISE NOTICE 'Exists: bank_one_primary_per_user';
  END IF;
END $$;

-- 16. Unique Iris account ID (non-null only)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'bank_iris_account_unique'
  ) THEN
    CREATE UNIQUE INDEX bank_iris_account_unique
      ON bank_accounts("irisAccountId")
      WHERE "irisAccountId" IS NOT NULL;
    RAISE NOTICE 'Added: bank_iris_account_unique';
  ELSE
    RAISE NOTICE 'Exists: bank_iris_account_unique';
  END IF;
END $$;

-- ============================================================
-- EVIDENCE FILE CONSTRAINTS
-- ============================================================

-- 17. Dispute evidence: file_urls and file_types must be same length
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'evidence_files_length'
  ) THEN
    ALTER TABLE dispute_evidences ADD CONSTRAINT evidence_files_length
      CHECK (
        array_length("fileUrls", 1) IS NOT DISTINCT FROM array_length("fileTypes", 1)
      );
    RAISE NOTICE 'Added: evidence_files_length';
  ELSE
    RAISE NOTICE 'Exists: evidence_files_length';
  END IF;
END $$;

-- 18. Dispute evidence: submitter XOR constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'evidence_submitter_xor'
  ) THEN
    ALTER TABLE dispute_evidences ADD CONSTRAINT evidence_submitter_xor
      CHECK (
        ("submittedByRole" IN ('BUYER', 'SELLER') AND "submittedByUserId" IS NOT NULL AND "submittedByAdminId" IS NULL) OR
        ("submittedByRole" = 'ADMIN'              AND "submittedByAdminId" IS NOT NULL AND "submittedByUserId" IS NULL) OR
        ("submittedByRole" = 'SYSTEM'             AND "submittedByUserId" IS NULL AND "submittedByAdminId" IS NULL)
      );
    RAISE NOTICE 'Added: evidence_submitter_xor';
  ELSE
    RAISE NOTICE 'Exists: evidence_submitter_xor';
  END IF;
END $$;

-- ============================================================
-- DB-005: Partial unique index on iris payout ID
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'wallet_tx_iris_payout_unique'
  ) THEN
    CREATE UNIQUE INDEX wallet_tx_iris_payout_unique
      ON wallet_transactions("irisPayoutId")
      WHERE "irisPayoutId" IS NOT NULL;
    RAISE NOTICE 'Added: wallet_tx_iris_payout_unique';
  ELSE
    RAISE NOTICE 'Exists: wallet_tx_iris_payout_unique';
  END IF;
END $$;

-- ============================================================
-- DB-006: Missing constraints from migrations
-- ============================================================

-- order_fee_sum: feeAmount = buyerFee + sellerFee
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'order_fee_sum'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT order_fee_sum
      CHECK ("feeAmount" = "buyerFeeAmount" + "sellerFeeAmount");
    RAISE NOTICE 'Added: order_fee_sum';
  ELSE
    RAISE NOTICE 'Exists: order_fee_sum';
  END IF;
END $$;

-- order_buyer_pay: buyerPayAmount = orderValue + buyerFeeAmount
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'order_buyer_pay'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT order_buyer_pay
      CHECK ("buyerPayAmount" = "orderValue" + "buyerFeeAmount");
    RAISE NOTICE 'Added: order_buyer_pay';
  ELSE
    RAISE NOTICE 'Exists: order_buyer_pay';
  END IF;
END $$;

-- order_seller_receive: sellerReceiveAmount = orderValue - sellerFeeAmount
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'order_seller_receive'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT order_seller_receive
      CHECK ("sellerReceiveAmount" = "orderValue" - "sellerFeeAmount");
    RAISE NOTICE 'Added: order_seller_receive';
  ELSE
    RAISE NOTICE 'Exists: order_seller_receive';
  END IF;
END $$;

-- delivery_deadline_range
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'delivery_deadline_range'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT delivery_deadline_range
      CHECK ("deliveryDeadlineDays" IS NULL OR ("deliveryDeadlineDays" >= 1 AND "deliveryDeadlineDays" <= 30));
    RAISE NOTICE 'Added: delivery_deadline_range';
  ELSE
    RAISE NOTICE 'Exists: delivery_deadline_range';
  END IF;
END $$;

-- block_no_self
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'block_no_self'
  ) THEN
    ALTER TABLE block_lists ADD CONSTRAINT block_no_self
      CHECK ("blockerId" != "blockedId");
    RAISE NOTICE 'Added: block_no_self';
  ELSE
    RAISE NOTICE 'Exists: block_no_self';
  END IF;
END $$;

-- wallet_tx_amounts_valid
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallet_tx_amounts_valid'
  ) THEN
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_tx_amounts_valid
      CHECK ("amount" >= 0);
    RAISE NOTICE 'Added: wallet_tx_amounts_valid';
  ELSE
    RAISE NOTICE 'Exists: wallet_tx_amounts_valid';
  END IF;
END $$;

-- wallet_tx_no_self_reversal
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'wallet_tx_no_self_reversal'
  ) THEN
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_tx_no_self_reversal
      CHECK ("reversalOfId" IS NULL OR "reversalOfId" != id);
    RAISE NOTICE 'Added: wallet_tx_no_self_reversal';
  ELSE
    RAISE NOTICE 'Exists: wallet_tx_no_self_reversal';
  END IF;
END $$;

-- ============================================================
-- DB-007: One active subscription per user
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'sub_one_active_per_user'
  ) THEN
    CREATE UNIQUE INDEX sub_one_active_per_user
      ON subscriptions("userId")
      WHERE status = 'ACTIVE';
    RAISE NOTICE 'Added: sub_one_active_per_user';
  ELSE
    RAISE NOTICE 'Exists: sub_one_active_per_user';
  END IF;
END $$;

-- ============================================================
-- DB-009: Case-insensitive username lookup
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_users_username_lower'
  ) THEN
    CREATE INDEX idx_users_username_lower
      ON users(LOWER(username));
    RAISE NOTICE 'Added: idx_users_username_lower';
  ELSE
    RAISE NOTICE 'Exists: idx_users_username_lower';
  END IF;
END $$;

-- ============================================================
-- DB-010: ChatMessage soft-delete consistency
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chat_message_soft_delete_consistent'
  ) THEN
    ALTER TABLE chat_messages ADD CONSTRAINT chat_message_soft_delete_consistent
      CHECK (
        ("isDeleted" = false AND "deletedAt" IS NULL) OR
        ("isDeleted" = true AND "deletedAt" IS NOT NULL)
      ) NOT VALID;
    ALTER TABLE chat_messages VALIDATE CONSTRAINT chat_message_soft_delete_consistent;
    RAISE NOTICE 'Added: chat_message_soft_delete_consistent';
  ELSE
    RAISE NOTICE 'Exists: chat_message_soft_delete_consistent';
  END IF;
END $$;

-- ============================================================
-- DB-015: OTP cleanup index
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_otp_cleanup'
  ) THEN
    CREATE INDEX idx_otp_cleanup
      ON otp_codes("isUsed", "expiresAt");
    RAISE NOTICE 'Added: idx_otp_cleanup';
  ELSE
    RAISE NOTICE 'Exists: idx_otp_cleanup';
  END IF;
END $$;

-- ============================================================
-- DB-021: Subscription fee savings constraint
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'subscription_fee_savings_valid'
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscription_fee_savings_valid
      CHECK ("feeSavingsUsed" >= 0 AND "feeSavingsLimit" >= 0
        AND "feeSavingsUsed" <= "feeSavingsLimit");
    RAISE NOTICE 'Added: subscription_fee_savings_valid';
  ELSE
    RAISE NOTICE 'Exists: subscription_fee_savings_valid';
  END IF;
END $$;

SQL

echo "All constraints applied successfully. ($(date))"
