-- Persist application language so the preference survives Redis eviction and process restarts.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "language" TEXT NOT NULL DEFAULT 'id';

-- Keep existing rows and reject unsupported values at the database boundary.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_language_supported'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_language_supported"
      CHECK ("language" IN ('id', 'en'));
  END IF;
END $$;
