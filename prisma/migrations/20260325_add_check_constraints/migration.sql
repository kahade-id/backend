-- Add CHECK constraints that were documented as comments in schema.prisma
-- Uses DO blocks so constraints are only added if they don't already exist

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_stats_non_negative') THEN
    ALTER TABLE users ADD CONSTRAINT user_stats_non_negative
      CHECK ("totalOrdersCompleted" >= 0 AND "totalOrdersAsBuyer" >= 0 AND "totalOrdersAsSeller" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balance_non_negative') THEN
    ALTER TABLE wallets ADD CONSTRAINT wallet_balance_non_negative
      CHECK ("availableBalance" >= 0 AND "escrowBalance" >= 0 AND "totalBalance" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_tx_amounts_valid') THEN
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_tx_amounts_valid
      CHECK (amount > 0 AND "balanceBefore" >= 0 AND "balanceAfter" >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_tx_no_self_reversal') THEN
    ALTER TABLE wallet_transactions ADD CONSTRAINT wallet_tx_no_self_reversal
      CHECK ("reversalTxId" IS NULL OR "reversalTxId" != id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_fee_sum') THEN
    ALTER TABLE orders ADD CONSTRAINT order_fee_sum
      CHECK ("buyerFeeAmount" + "sellerFeeAmount" = "feeAmount");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_buyer_pay') THEN
    ALTER TABLE orders ADD CONSTRAINT order_buyer_pay
      CHECK ("buyerPayAmount" = "orderValue" + "buyerFeeAmount");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_seller_receive') THEN
    ALTER TABLE orders ADD CONSTRAINT order_seller_receive
      CHECK ("sellerReceiveAmount" = "orderValue" - "sellerFeeAmount");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'delivery_deadline_range') THEN
    ALTER TABLE orders ADD CONSTRAINT delivery_deadline_range
      CHECK ("deliveryDeadlineDays" BETWEEN 1 AND 14);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'extension_days_range') THEN
    ALTER TABLE order_extension_requests ADD CONSTRAINT extension_days_range
      CHECK ("extensionDays" BETWEEN 1 AND 14);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rating_stars_range') THEN
    ALTER TABLE ratings ADD CONSTRAINT rating_stars_range
      CHECK (stars BETWEEN 1 AND 5);
  END IF;
END $$;
