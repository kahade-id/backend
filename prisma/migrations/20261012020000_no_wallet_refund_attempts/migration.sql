-- Misi tanpa-wallet (BI-safe): migrasi 100% ADITIF.
-- 1) Scope baru EscrowDisbursement untuk payout non-order (cashback, referral,
--    dispute release). Dana tetap dicairkan ke rekening bank terverifikasi
--    (EscrowDisbursementService) — tanpa rekening → HELD_NO_BANK fail-closed.
-- 2) Tabel dana_refund_attempts: idempotency refund DANA (penuh & parsial) ke
--    metode bayar asal. Satu baris per idempotencyKey — retry aman.

ALTER TYPE "EscrowDisbursementScope" ADD VALUE IF NOT EXISTS 'CASHBACK';
ALTER TYPE "EscrowDisbursementScope" ADD VALUE IF NOT EXISTS 'REFERRAL';
ALTER TYPE "EscrowDisbursementScope" ADD VALUE IF NOT EXISTS 'DISPUTE_RELEASE';

CREATE TABLE "dana_refund_attempts" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "paymentTransactionId" TEXT NOT NULL,
    "amountSen" BIGINT NOT NULL,
    "partnerRefundNo" TEXT NOT NULL,
    "danaReferenceNo" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dana_refund_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dana_refund_attempts_idempotencyKey_key" ON "dana_refund_attempts"("idempotencyKey");
CREATE UNIQUE INDEX "dana_refund_attempts_partnerRefundNo_key" ON "dana_refund_attempts"("partnerRefundNo");
CREATE INDEX "dana_refund_attempts_paymentTransactionId_idx" ON "dana_refund_attempts"("paymentTransactionId");
