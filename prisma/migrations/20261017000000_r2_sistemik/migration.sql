-- SYS-B-203 (audit sistemik ronde 3, 2026-10-03): catat status aktual refund
-- sisi DANA (parsed dari respons, bukan difabrikasi) + kapan refund
-- terkonfirmasi settle di DANA pada dana_refund_attempts.
-- Additive-only: dua kolom nullable baru, tanpa backfill, tanpa ubah data.
ALTER TABLE "dana_refund_attempts" ADD COLUMN "providerStatus" TEXT;
ALTER TABLE "dana_refund_attempts" ADD COLUMN "settledAt" TIMESTAMPTZ(3);
