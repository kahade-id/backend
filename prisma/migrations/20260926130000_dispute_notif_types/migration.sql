-- Tipe notifikasi baru untuk bukti & klaim sengketa.
-- Dipakai agar lawan sengketa dan admin yang di-assign tahu ada bukti/klaim baru
-- (sebelumnya submitEvidence/submitClaim tidak mengirim notifikasi sama sekali).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISPUTE_EVIDENCE_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISPUTE_CLAIM_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISPUTE_ESCALATED';
