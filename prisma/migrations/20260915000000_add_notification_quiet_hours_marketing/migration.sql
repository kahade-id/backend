-- Add quiet hours, marketing push/inApp, language to notification_preferences
ALTER TABLE "notification_preferences"
  ADD COLUMN IF NOT EXISTS "marketingPush" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "marketingInApp" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "quietHoursEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "quietHoursStart" TEXT DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS "quietHoursEnd" TEXT DEFAULT '07:00',
  ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'id';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notification_preferences_language_supported'
  ) THEN
    ALTER TABLE "notification_preferences"
      ADD CONSTRAINT "notification_preferences_language_supported"
      CHECK ("language" IN ('id', 'en'));
  END IF;
END $$;
