-- Item 7-10 batch 2026-09-28 (TIM B): preferensi digest notifikasi.
-- Additive-only: dua kolom baru di notification_preferences (nullable/default,
-- tidak menyentuh data existing) + satu nilai enum baru di AKHIR NotificationType.
-- Nilai enum existing TIDAK diubah/diurutkan ulang.

ALTER TABLE "notification_preferences"
  ADD COLUMN "digest_frequency" TEXT NOT NULL DEFAULT 'off';

ALTER TABLE "notification_preferences"
  ADD COLUMN "last_digest_sent_at" TIMESTAMPTZ(3);

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'DIGEST_SUMMARY';
