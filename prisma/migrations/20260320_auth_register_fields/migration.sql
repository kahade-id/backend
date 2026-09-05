-- Migration: Add phone_number, date_of_birth, gender to users table
-- Semua field nullable karena existing users tidak punya data ini

-- Create Gender enum (idempotent)
DO $$ BEGIN
  CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add columns to users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "phoneNumber"   TEXT,
  ADD COLUMN IF NOT EXISTS "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dateOfBirth"   DATE,
  ADD COLUMN IF NOT EXISTS "gender"        "Gender";

-- Unique constraint for phone (one account per number), partial to allow NULLs
CREATE UNIQUE INDEX IF NOT EXISTS "users_phoneNumber_key"
  ON "users" ("phoneNumber")
  WHERE "phoneNumber" IS NOT NULL;

-- Index for DOB (admin analytics / age-gating future use)
CREATE INDEX IF NOT EXISTS "idx_users_dateOfBirth" ON "users" ("dateOfBirth");
