-- CHECK constraints for data integrity (idempotent with DO $$ blocks)

DO $$ BEGIN
  ALTER TABLE "wallets" ADD CONSTRAINT "wallet_balance_non_negative"
    CHECK ("availableBalance" >= 0 AND "escrowBalance" >= 0 AND "totalBalance" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "ratings" ADD CONSTRAINT "rating_stars_range"
    CHECK ("stars" BETWEEN 1 AND 5);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "order_value_positive"
    CHECK ("orderValue" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "order_fee_sum"
    CHECK ("buyerFeeAmount" + "sellerFeeAmount" = "feeAmount");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "order_buyer_pay"
    CHECK ("buyerPayAmount" = "orderValue" + "buyerFeeAmount");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "orders" ADD CONSTRAINT "order_seller_receive"
    CHECK ("sellerReceiveAmount" = "orderValue" - "sellerFeeAmount");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_decisions" ADD CONSTRAINT "decision_amounts_non_negative"
    CHECK ("buyerAmount" >= 0 AND "sellerAmount" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_decisions" ADD CONSTRAINT "split_percent_sum"
    CHECK (
      ("buyerPercent" IS NULL AND "sellerPercent" IS NULL) OR
      ("buyerPercent" + "sellerPercent" = 100)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_decisions" ADD CONSTRAINT "split_buyer_percent_range"
    CHECK ("buyerPercent" IS NULL OR ("buyerPercent" BETWEEN 0 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_decisions" ADD CONSTRAINT "split_seller_percent_range"
    CHECK ("sellerPercent" IS NULL OR ("sellerPercent" BETWEEN 0 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "disputes" ADD CONSTRAINT "dispute_sla_hours_positive"
    CHECK ("slaHours" IS NULL OR "slaHours" > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Partial unique indexes for "only one active" invariants
CREATE UNIQUE INDEX IF NOT EXISTS "kyc_one_pending_per_user"
  ON "kyc_requests" ("userId")
  WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS "bank_one_primary_per_user"
  ON "bank_accounts" ("userId")
  WHERE "isPrimary" = true AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "sub_one_active_per_user"
  ON "subscriptions" ("userId")
  WHERE "status" = 'ACTIVE';
