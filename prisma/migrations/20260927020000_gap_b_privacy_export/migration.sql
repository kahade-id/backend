-- Migration: GAP-B kontrol privasi & ekspor data (G076–G100).
--
-- Append-only: hanya CREATE baru + ADD VALUE di akhir enum. Semua statement
-- idempoten (IF NOT EXISTS) supaya aman dijalankan ulang.

-- 1. UserAuditAction: nilai audit baru di AKHIR enum (append-only).
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'PRIVACY_SETTINGS_UPDATED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'CONSENT_GRANTED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'CONSENT_REVOKED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'DATA_EXPORT_REQUESTED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'DATA_EXPORT_DOWNLOADED';

-- 2. Enum baru untuk model GAP-B.
DO $$ BEGIN
  CREATE TYPE "PrivacyListVisibility" AS ENUM ('EVERYONE', 'FOLLOWERS', 'ONLY_ME');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "QaCommentPolicy" AS ENUM ('EVERYONE', 'FOLLOWERS', 'DISABLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ConsentType" AS ENUM ('MARKETING_PUSH', 'MARKETING_EMAIL', 'MARKETING_WHATSAPP', 'TRANSACTIONAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DataExportStatus" AS ENUM ('PENDING', 'READY', 'EXPIRED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "DataExportFormat" AS ENUM ('JSON', 'CSV');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3. Tabel privacy_settings (G076–G083).
CREATE TABLE IF NOT EXISTS "privacy_settings" (
  "id"                          TEXT NOT NULL,
  "userId"                      TEXT NOT NULL,
  "showEmail"                   BOOLEAN NOT NULL DEFAULT false,
  "showPhone"                   BOOLEAN NOT NULL DEFAULT false,
  "showDob"                     BOOLEAN NOT NULL DEFAULT false,
  "showGender"                  BOOLEAN NOT NULL DEFAULT false,
  "showFollowerList"            "PrivacyListVisibility" NOT NULL DEFAULT 'EVERYONE',
  "showFollowingList"           "PrivacyListVisibility" NOT NULL DEFAULT 'EVERYONE',
  "showcaseDefaultVisibility"   "ShowcaseVisibility" NOT NULL DEFAULT 'PUBLIC',
  "qaCommentPolicy"             "QaCommentPolicy" NOT NULL DEFAULT 'EVERYONE',
  "qaAnswerModeration"          BOOLEAN NOT NULL DEFAULT false,
  "showReviews"                 BOOLEAN NOT NULL DEFAULT true,
  "hiddenStats"                 TEXT[] NOT NULL DEFAULT '{}',
  "searchEngineIndex"           BOOLEAN NOT NULL DEFAULT true,
  "createdAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "privacy_settings" ADD CONSTRAINT "privacy_settings_userId_key" UNIQUE ("userId");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "privacy_settings"
    ADD CONSTRAINT "privacy_settings_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Tabel consent_records (G084–G086).
CREATE TABLE IF NOT EXISTS "consent_records" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "type"           "ConsentType" NOT NULL,
  "policyVersion"  TEXT NOT NULL,
  "policyTextHash" VARCHAR(64) NOT NULL,
  "channel"        VARCHAR(32),
  "grantedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"      TIMESTAMP(3),
  "ipHash"         VARCHAR(64),
  CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "consent_records"
    ADD CONSTRAINT "consent_records_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "consent_records_userId_idx" ON "consent_records"("userId");
CREATE INDEX IF NOT EXISTS "consent_records_userId_type_grantedAt_idx" ON "consent_records"("userId", "type", "grantedAt");

-- 5. Tabel data_export_requests (G087–G088, G100).
CREATE TABLE IF NOT EXISTS "data_export_requests" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "status"        "DataExportStatus" NOT NULL DEFAULT 'PENDING',
  "format"        "DataExportFormat" NOT NULL DEFAULT 'JSON',
  "artifactKey"   TEXT,
  "requestedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readyAt"       TIMESTAMP(3),
  "expiresAt"     TIMESTAMP(3),
  "downloadedAt"  TIMESTAMP(3),
  "downloadCount" INTEGER NOT NULL DEFAULT 0,
  "failureReason" TEXT,
  CONSTRAINT "data_export_requests_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  ALTER TABLE "data_export_requests"
    ADD CONSTRAINT "data_export_requests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "data_export_requests_userId_requestedAt_idx" ON "data_export_requests"("userId", "requestedAt");
