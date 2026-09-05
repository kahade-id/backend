-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'LINKAJA';
ALTER TYPE "PaymentMethod" ADD VALUE 'ALFAMART';
ALTER TYPE "PaymentMethod" ADD VALUE 'INDOMARET';
ALTER TYPE "PaymentMethod" ADD VALUE 'AKULAKU';
ALTER TYPE "PaymentMethod" ADD VALUE 'KREDIVO';

-- AlterTable: add paymentFee and grossAmount columns
ALTER TABLE "payment_transactions" ADD COLUMN "paymentFee" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "payment_transactions" ADD COLUMN "grossAmount" BIGINT NOT NULL DEFAULT 0;

-- Backfill: set grossAmount = amount for existing rows (pre-fee records)
UPDATE "payment_transactions" SET "grossAmount" = "amount" WHERE "grossAmount" = 0;
