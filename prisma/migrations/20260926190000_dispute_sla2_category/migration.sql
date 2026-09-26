-- SLA tahap kedua pasca-eskalasi + kategori sengketa + tipe notifikasi baru.
--
-- 1. Kolom escalatedAt / escalationSlaDeadlineAt / escalationSlaWarningSentAt /
--    isEscalationSlaBreached: setelah status ESCALATED, admin punya 3x24 jam
--    untuk memberi putusan. Warning dikirim 24 jam sebelum deadline.
-- 2. Enum DisputeCategory + kolom category di disputes (nullable agar data lama aman).
-- 3. Tipe notifikasi baru: DISPUTE_MESSAGE_RECEIVED (push saat lawan offline),
--    DISPUTE_ESCALATION_SLA_WARNING, DISPUTE_ESCALATION_SLA_BREACHED.

-- Enum kategori sengketa
DO $$ BEGIN
  CREATE TYPE "DisputeCategory" AS ENUM (
    'ITEM_NOT_RECEIVED',
    'ITEM_NOT_AS_DESCRIBED',
    'DAMAGED_ITEM',
    'WRONG_ITEM',
    'SERVICE_NOT_RENDERED',
    'PAYMENT_ISSUE',
    'FRAUD',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "escalatedAt" TIMESTAMP(3);
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "escalationSlaDeadlineAt" TIMESTAMP(3);
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "escalationSlaWarningSentAt" TIMESTAMP(3);
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "isEscalationSlaBreached" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "category" "DisputeCategory";

CREATE INDEX IF NOT EXISTS "disputes_escalationSlaDeadlineAt_idx"
  ON "disputes"("escalationSlaDeadlineAt")
  WHERE "escalationSlaDeadlineAt" IS NOT NULL AND "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "disputes_category_idx"
  ON "disputes"("category")
  WHERE "category" IS NOT NULL AND "deletedAt" IS NULL;

-- Tipe notifikasi baru (PostgreSQL tidak mengizinkan ADD VALUE di dalam
-- blok transaksi bila enum dipakai di tabel — Prisma menjalankan migration
-- dalam transaksi, jadi gunakan pola yang sama seperti migration sebelumnya).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISPUTE_MESSAGE_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISPUTE_ESCALATION_SLA_WARNING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DISPUTE_ESCALATION_SLA_BREACHED';
