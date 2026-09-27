-- GAP-A: login sosial (G001–G025). Append-only: hanya tambah type/tabel/kolom/nilai enum.
-- Aman di-retry (IF NOT EXISTS).

-- G012: enum provider sosial
DO $$ BEGIN
  CREATE TYPE "SocialProvider" AS ENUM ('GOOGLE', 'APPLE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- G012: tabel relasi provider-subject yang stabil
CREATE TABLE IF NOT EXISTS "social_accounts" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "SocialProvider" NOT NULL,
  "providerSub" TEXT NOT NULL,
  "email" TEXT,
  "linkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMPTZ(6),
  "consentAt" TIMESTAMPTZ(6),
  "consentTextVersion" TEXT,
  CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "social_accounts_provider_providerSub_key" ON "social_accounts"("provider", "providerSub");
CREATE INDEX IF NOT EXISTS "social_accounts_userId_idx" ON "social_accounts"("userId");
DO $$ BEGIN
  ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- G015: flag verifikasi nomor untuk user login sosial (default false = tanpa perubahan perilaku user lama)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "requiresPhoneVerification" BOOLEAN NOT NULL DEFAULT false;
-- Backfill: user dengan nomor belum terverifikasi (karakteristik akun sosial lama) wajib verifikasi
-- nomor sebelum aksi sensitif. User registrasi HP via OTP selalu phoneVerified=true sehingga tidak terdampak.
UPDATE "users" SET "requiresPhoneVerification" = true
WHERE "phoneVerified" = false AND "deletedAt" IS NULL AND "requiresPhoneVerification" = false;

-- G022: nilai audit baru (append-only, di AKHIR enum)
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SOCIAL_PROVIDER_LINKED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SOCIAL_PROVIDER_UNLINKED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SOCIAL_LOGIN';

-- G021: tipe notifikasi keamanan baru (append-only, di AKHIR enum)
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SECURITY_SOCIAL_LINKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SECURITY_SOCIAL_UNLINKED';
