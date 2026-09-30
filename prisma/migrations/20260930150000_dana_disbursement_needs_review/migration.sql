-- Tambah status NEEDS_REVIEW ke EscrowDisbursementStatus (additive-only).
--
-- Konteks: webhook DANA Transfer to Bank Notify bisa mengirim
-- latestTransactionStatus di luar rentang 00–07 yang dikenal. Keputusan
-- eksplisit: status tak dikenal DITANDAI untuk review manual, BUKAN
-- otomatis FAILED (fail-closed — keputusan finansial tidak boleh
-- ditebak dari kode status yang tidak dipahami).
--
-- Pola idempoten mengikuti migrasi 20261011000000_dana_provider.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'NEEDS_REVIEW'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'EscrowDisbursementStatus')) THEN
    ALTER TYPE "EscrowDisbursementStatus" ADD VALUE 'NEEDS_REVIEW';
  END IF;
END $$;
