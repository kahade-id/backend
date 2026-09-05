-- Persistent saved profiles. This migration is committed for a future immutable
-- release but is intentionally not executed by the audit workflow.
CREATE TABLE IF NOT EXISTS "user_saved_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "savedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_saved_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_saved_profiles_userId_savedUserId_key"
  ON "user_saved_profiles"("userId", "savedUserId");
CREATE INDEX IF NOT EXISTS "user_saved_profiles_userId_createdAt_idx"
  ON "user_saved_profiles"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "user_saved_profiles_savedUserId_idx"
  ON "user_saved_profiles"("savedUserId");

DO $$ BEGIN
  ALTER TABLE "user_saved_profiles"
    ADD CONSTRAINT "user_saved_profiles_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_saved_profiles"
    ADD CONSTRAINT "user_saved_profiles_savedUserId_fkey"
    FOREIGN KEY ("savedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
