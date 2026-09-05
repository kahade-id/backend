-- Migration: Phone-based OTP authentication
-- 1. Make email and password nullable (phone-first auth)
-- 2. Add address column to users
-- 3. Make phoneNumber NOT NULL (required for all users)
-- 4. Add OtpMethod enum and PHONE_LOGIN to OtpType
-- 5. Add phone and method columns to otp_codes

-- Step 1: Make email nullable
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Step 2: Make password nullable
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;

-- Step 3: Add address column
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "address" VARCHAR(500);

-- Step 4: Make phoneNumber NOT NULL
-- First, ensure all existing users have a placeholder phone number
UPDATE "users" SET "phoneNumber" = '+62000' || LPAD(FLOOR(RANDOM() * 100000000)::TEXT, 8, '0')
  WHERE "phoneNumber" IS NULL;

ALTER TABLE "users" ALTER COLUMN "phoneNumber" SET NOT NULL;

-- Drop old partial unique index and create a full unique index
DROP INDEX IF EXISTS "users_phoneNumber_key";
CREATE UNIQUE INDEX "users_phoneNumber_key" ON "users" ("phoneNumber");

-- Step 5: Create OtpMethod enum
DO $$ BEGIN
  CREATE TYPE "OtpMethod" AS ENUM ('SMS', 'WHATSAPP');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Step 6: Add PHONE_LOGIN to OtpType enum
DO $$ BEGIN
  ALTER TYPE "OtpType" ADD VALUE IF NOT EXISTS 'PHONE_LOGIN';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Step 7: Add phone and method columns to otp_codes
ALTER TABLE "otp_codes"
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "method" "OtpMethod";

-- Step 8: Make email nullable in otp_codes (was NOT NULL)
ALTER TABLE "otp_codes" ALTER COLUMN "email" DROP NOT NULL;

-- Step 9: Add index on phone+type for otp_codes
CREATE INDEX IF NOT EXISTS "otp_codes_phone_type_idx" ON "otp_codes" ("phone", "type");
