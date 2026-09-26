-- Migration: audit trail sengketa (Batch 2A).
--
-- 1. UserAuditAction: tambah DISPUTE_EVIDENCE_DELETED — penghapusan bukti sengketa
--    sebelumnya diaudit sebagai DISPUTE_EVIDENCE_ADDED (menyesatkan forensik).
-- 2. AuditAction (admin): tambah DISPUTE_EVIDENCE_SUBMITTED & DISPUTE_CLAIM_SUBMITTED
--    untuk notifikasi admin yang ditugaskan saat ada bukti/klaim baru.
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'DISPUTE_EVIDENCE_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPUTE_EVIDENCE_SUBMITTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'DISPUTE_CLAIM_SUBMITTED';

-- 3. DisputeDecision.decidedBy nullable — resolusi mutual diputuskan kedua pihak,
--    bukan admin (DP-023).
ALTER TABLE "dispute_decisions" ALTER COLUMN "decidedBy" DROP NOT NULL;
