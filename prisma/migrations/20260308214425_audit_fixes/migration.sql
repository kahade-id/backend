-- DropForeignKey (idempotent: ignore if already dropped)
ALTER TABLE "bank_accounts" DROP CONSTRAINT IF EXISTS "bank_accounts_userId_fkey";

-- DropForeignKey
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "wallets_userId_fkey";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "voucher_usages_voucherId_userId_idx" ON "voucher_usages"("voucherId", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wallet_transactions_type_status_createdAt_idx" ON "wallet_transactions"("type", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "bank_accounts" DROP CONSTRAINT IF EXISTS "bank_accounts_userId_fkey";
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "wallets_userId_fkey";
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
