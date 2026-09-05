-- This migration's directory name sorts before 20260308201139_init, so on a
-- fresh database it runs before the tables below exist. Guard every statement
-- on table existence: fresh databases get these columns from
-- 20260417_full_schema_sync, which adds the identical set idempotently.

-- AlterTable: Add soft-delete columns
DO $$
BEGIN
  IF to_regclass('public."orders"') IS NOT NULL THEN
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
  END IF;
  IF to_regclass('public."wallets"') IS NOT NULL THEN
    ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
  END IF;
  IF to_regclass('public."chat_rooms"') IS NOT NULL THEN
    ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
  END IF;
  IF to_regclass('public."disputes"') IS NOT NULL THEN
    ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
  END IF;

  -- AlterTable: Add phoneNumberHash for PII encryption lookup
  -- CreateIndex: unique constraint on phoneNumberHash
  IF to_regclass('public."users"') IS NOT NULL THEN
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phoneNumberHash" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "users_phoneNumberHash_key" ON "users"("phoneNumberHash");
  END IF;
END $$;
