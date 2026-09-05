CREATE INDEX IF NOT EXISTS "users_fulltext_search_idx"
  ON "users"
  USING GIN (to_tsvector('simple', coalesce(username, '') || ' ' || "fullName"));

ALTER TABLE "wallets"
  ADD CONSTRAINT "wallets_availableBalance_non_negative" CHECK ("availableBalance" >= 0),
  ADD CONSTRAINT "wallets_escrowBalance_non_negative" CHECK ("escrowBalance" >= 0),
  ADD CONSTRAINT "wallets_totalBalance_non_negative" CHECK ("totalBalance" >= 0);

ALTER TABLE "vouchers"
  ADD CONSTRAINT "vouchers_validUntil_after_validFrom" CHECK ("validUntil" > "validFrom"),
  ADD CONSTRAINT "vouchers_currentUsage_non_negative" CHECK ("currentUsage" >= 0),
  ADD CONSTRAINT "vouchers_maxUsageTotal_positive" CHECK ("maxUsageTotal" IS NULL OR "maxUsageTotal" > 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_deliveryDeadlineDays_positive" CHECK ("deliveryDeadlineDays" > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_tx_iris_payout_unique"
  ON "wallet_transactions"("irisPayoutId")
  WHERE "irisPayoutId" IS NOT NULL;

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_tx_amount_positive" CHECK ("amount" > 0);
