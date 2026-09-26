-- Migration: quiet hours timezone per-user (Batch 4A, CN-008).
--
-- Kolom baru NotificationPreference.quietHoursTimezone (IANA tz database).
-- Default "Asia/Jakarta" mempertahankan perilaku lama (WIB hardcode) untuk
-- preferensi yang sudah ada; klien mengisi dari device timezone.
-- BELUM DI-APPLY — koordinator apply saat deploy.
ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "quietHoursTimezone" TEXT DEFAULT 'Asia/Jakarta';
