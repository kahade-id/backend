-- BAI-086/088/095 (audit integrasi BE↔Admin, Domain 5 dispute & operasional).
-- Additive-only: tidak ada DROP/ALTER merusak; semua IF NOT EXISTS.
-- 1. disputes.mediatorJoinedNotifiedAt — flag sekali-kirim DISPUTE_ADMIN_JOINED
--    saat mediator yang di-assign pertama kali memasuki room order (BAI-088).
-- 2. dispute_internal_notes — catatan internal kolaboratif antar admin untuk
--    sengketa; menggantikan localStorage per-perangkat di panel admin (BAI-095).

ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "mediatorJoinedNotifiedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "dispute_internal_notes" (
  "id" TEXT NOT NULL,
  "disputeId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dispute_internal_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "dispute_internal_notes_disputeId_createdAt_idx"
  ON "dispute_internal_notes"("disputeId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "dispute_internal_notes"
    ADD CONSTRAINT "dispute_internal_notes_disputeId_fkey"
    FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_internal_notes"
    ADD CONSTRAINT "dispute_internal_notes_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
