-- BAI-043/044/045 (2026-10-01): kode audit spesifik untuk aksi admin atas
-- lifecycle EscrowDisbursement DANA (read-only queue + review NEEDS_REVIEW +
-- requeue HELD_NO_BANK + recheck status ke provider DANA).
-- Additive-only: hanya menambah nilai enum AuditAction (idempotent).
-- Tidak ada perubahan kolom/tabel existing; alur escrow/wallet tidak tersentuh.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DISBURSEMENT_VIEWED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditAction')) THEN
    ALTER TYPE "AuditAction" ADD VALUE 'DISBURSEMENT_VIEWED';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DISBURSEMENT_RECHECKED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditAction')) THEN
    ALTER TYPE "AuditAction" ADD VALUE 'DISBURSEMENT_RECHECKED';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DISBURSEMENT_REVIEWED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditAction')) THEN
    ALTER TYPE "AuditAction" ADD VALUE 'DISBURSEMENT_REVIEWED';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'DISBURSEMENT_REQUEUED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'AuditAction')) THEN
    ALTER TYPE "AuditAction" ADD VALUE 'DISBURSEMENT_REQUEUED';
  END IF;
END $$;
