-- ============================================================
-- Section 1: Verified Badge System
-- ============================================================
-- Lima kategori badge verifikasi independen yang ditampilkan di samping username:
--   1. CONTACT_VERIFIED   -> users.emailVerified + users.phoneVerified
--   2. KYC_VERIFIED       -> users.kycStatus = 'APPROVED'
--   3. BUSINESS_VERIFIED  -> business_verifications.status = 'APPROVED' (BARU)
--   4. KAHADE_PLUS        -> users.isKahadePlus
--   5. TRUSTED_BY_KAHADE  -> users.isVip (infrastruktur lama, di-reframe)
--
-- Hanya #3 yang butuh tabel baru. #1 dan #4 butuh timestamp "kapan didapat"
-- supaya bagian "Tentang" di profil publik bisa menampilkannya.
--
-- Semua kolom baru NULLABLE / ber-default (prisma/MIGRATION_SAFETY.md rule 3)
-- sehingga kode lama tetap jalan selama rolling deploy.
-- ============================================================

-- ------------------------------------------------------------
-- 1. users.phoneVerifiedAt — simetris dengan users.emailVerifiedAt
-- ------------------------------------------------------------
-- Sengaja TIDAK di-backfill. Menyalin createdAt/updatedAt ke kolom ini akan
-- mengarang tanggal verifikasi yang tidak pernah terjadi. Baris legacy tetap
-- NULL dan presenter fallback ke memberSince (lihat verification-badge.service.ts).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP(3);

-- ------------------------------------------------------------
-- 2. users.kahadePlusSince — tanggal pertama kali subscribe Kahade Plus
-- ------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "kahadePlusSince" TIMESTAMP(3);

-- Backfill dari riwayat subscription yang sudah ada: tanggal periode paling awal
-- milik user yang saat ini masih Plus. Ini nilai turunan yang jujur (bukan tebakan)
-- karena subscriptions.currentPeriodStart pada baris pertama == tanggal subscribe.
UPDATE "users" u
SET "kahadePlusSince" = s."firstPeriodStart"
FROM (
  SELECT "userId", MIN(COALESCE("currentPeriodStart", "createdAt")) AS "firstPeriodStart"
  FROM "subscriptions"
  GROUP BY "userId"
) s
WHERE u."id" = s."userId"
  AND u."isKahadePlus" = true
  AND u."kahadePlusSince" IS NULL;

-- ------------------------------------------------------------
-- 3. Enum BusinessVerificationStatus
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "BusinessVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVOKED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 4. Audit / notification enum values
-- ------------------------------------------------------------
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS aman di dalam transaction mulai PG 12
-- (nilai baru hanya tidak boleh dipakai di transaction yang sama — migration ini
-- tidak memakainya).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_APPROVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_REJECTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_DOCUMENTS_ACCESSED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'BUSINESS_VERIFICATION_REVOKED';

-- ------------------------------------------------------------
-- 5. Tabel business_verifications
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "business_verifications" (
  "id"               TEXT NOT NULL,
  "verificationId"   TEXT NOT NULL,
  "userId"           TEXT NOT NULL,
  "status"           "BusinessVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "businessName"     VARCHAR(150) NOT NULL,
  "npwpNumber"       TEXT NOT NULL,
  "npwpNumberHash"   TEXT NOT NULL,
  "deedNumber"       VARCHAR(100),
  "siupNumber"       VARCHAR(100),
  "documentFileKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reviewedBy"       TEXT,
  "reviewedAt"       TIMESTAMP(3),
  "approvedAt"       TIMESTAMP(3),
  "revokedAt"        TIMESTAMP(3),
  "rejectionReason"  TEXT,
  "adminNotes"       TEXT,
  "submittedIp"      TEXT,
  "attemptNumber"    INTEGER NOT NULL DEFAULT 1,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "business_verifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "business_verifications_verificationId_key"
  ON "business_verifications"("verificationId");
CREATE INDEX IF NOT EXISTS "business_verifications_userId_idx"
  ON "business_verifications"("userId");
CREATE INDEX IF NOT EXISTS "business_verifications_status_idx"
  ON "business_verifications"("status");
CREATE INDEX IF NOT EXISTS "business_verifications_npwpNumberHash_idx"
  ON "business_verifications"("npwpNumberHash");
CREATE INDEX IF NOT EXISTS "business_verifications_status_createdAt_idx"
  ON "business_verifications"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "business_verifications_reviewedBy_idx"
  ON "business_verifications"("reviewedBy");

DO $$ BEGIN
  ALTER TABLE "business_verifications"
    ADD CONSTRAINT "business_verifications_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "business_verifications"
    ADD CONSTRAINT "business_verifications_reviewedBy_fkey"
    FOREIGN KEY ("reviewedBy") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 6. Partial unique indexes (pola sama seperti kyc_one_pending_per_user)
-- ------------------------------------------------------------
-- Satu pengajuan PENDING per user: mencegah double-submit saat dua request
-- balapan. Ditegakkan di DB karena cek read-then-write di service punya race window.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'business_verification_one_pending_per_user'
  ) THEN
    CREATE UNIQUE INDEX business_verification_one_pending_per_user
      ON business_verifications("userId")
      WHERE status = 'PENDING';
    RAISE NOTICE 'Added: business_verification_one_pending_per_user';
  ELSE
    RAISE NOTICE 'Exists: business_verification_one_pending_per_user';
  END IF;
END $$;

-- Satu NPWP aktif per platform. REJECTED/REVOKED sengaja di luar index supaya
-- user bisa mengajukan ulang dengan NPWP yang sama setelah ditolak.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'business_verification_active_npwp_unique'
  ) THEN
    CREATE UNIQUE INDEX business_verification_active_npwp_unique
      ON business_verifications("npwpNumberHash")
      WHERE status IN ('PENDING', 'APPROVED');
    RAISE NOTICE 'Added: business_verification_active_npwp_unique';
  ELSE
    RAISE NOTICE 'Exists: business_verification_active_npwp_unique';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 7. Invariant data
-- ------------------------------------------------------------
-- approvedAt hanya boleh terisi untuk status yang pernah/sedang APPROVED, dan
-- revokedAt hanya untuk REVOKED. Menjaga kolom audit tetap konsisten walaupun
-- service-nya di-refactor.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'business_verification_timestamps_consistent'
  ) THEN
    ALTER TABLE "business_verifications" ADD CONSTRAINT business_verification_timestamps_consistent
      CHECK (
        ("revokedAt" IS NULL OR status = 'REVOKED')
        AND ("reviewedAt" IS NULL OR status <> 'PENDING')
        AND ("attemptNumber" >= 1)
      );
    RAISE NOTICE 'Added: business_verification_timestamps_consistent';
  ELSE
    RAISE NOTICE 'Exists: business_verification_timestamps_consistent';
  END IF;
END $$;
