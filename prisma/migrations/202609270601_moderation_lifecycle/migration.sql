-- Migration: GAP-F (G401–G425) — lifecycle moderasi pasca-final laporan etalase.
--
-- Nama migrasi: 202609270601_moderation_lifecycle
--
-- APPEND-ONLY: hanya CREATE TYPE / CREATE TABLE / CREATE INDEX baru.
-- TIDAK ADA perubahan pada tabel existing. Satu-satunya pengecualian adalah
-- penambahan nilai enum pada NotificationType (append-only, nilai existing
-- tidak diubah).
--
-- PENTING — ALTER TYPE ... ADD VALUE tidak bisa dijalankan di dalam blok
-- transaksi. Prisma migrate membungkus tiap file migrasi dalam satu transaksi,
-- sehingga EMPAT statement di bagian 1 di bawah HARUS dijalankan manual via
-- psql (atau tool setara) di luar transaksi, SEBELUM `prisma migrate deploy`:
--
--   ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_REPORT_UPDATE';
--   ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_ITEM_TAKEDOWN';
--   ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_APPEAL_DECIDED';
--   ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SHOWCASE_APPEAL_FILED';
--
-- Statement tersebut tetap dicantumkan di bagian 1 sebagai dokumentasi, tetapi
-- diberi comment agar tidak dieksekusi oleh Prisma migrate (akan gagal dengan
-- "ALTER TYPE ... ADD VALUE cannot run inside a transaction block").

-- ============================================================
-- 1. ENUM VALUES (dokumentasi — JALANKAN MANUAL via psql, lihat catatan di atas)
-- ============================================================
-- ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_REPORT_UPDATE';
-- ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_ITEM_TAKEDOWN';
-- ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MODERATION_APPEAL_DECIDED';
-- ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'SHOWCASE_APPEAL_FILED';

-- ============================================================
-- 2. ENUMS BARU
-- ============================================================
CREATE TYPE "ModerationEventAction" AS ENUM (
  'REOPENED', 'NOTE_ADDED', 'APPEAL_FILED', 'APPEAL_DECIDED', 'RESTORED',
  'RESTRICTED', 'TAKEDOWN', 'ASSIGNED', 'ESCALATED', 'EXPORTED',
  'DISMISSED', 'NO_ACTION', 'UNDER_REVIEW'
);

CREATE TYPE "ModerationReasonCode" AS ENUM (
  'SPAM', 'HARASSMENT', 'FRAUD_SUSPECTED', 'PROHIBITED_ITEM',
  'MISLEADING', 'IP_VIOLATION', 'NUDITY', 'OTHER'
);

CREATE TYPE "AppealStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TYPE "AppellantType" AS ENUM ('OWNER', 'REPORTER');

-- ============================================================
-- 3. TABLES BARU
-- ============================================================

-- Jejak audit append-only semua aksi moderasi (G403, G420).
CREATE TABLE "report_moderation_events" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "reportId"     TEXT NOT NULL REFERENCES "showcase_reports"("id") ON DELETE CASCADE,
  "actorAdminId" TEXT,
  "action"       "ModerationEventAction" NOT NULL,
  "stateFrom"    "ReportStatus",
  "stateTo"      "ReportStatus",
  "reasonCode"   "ModerationReasonCode",
  "note"         TEXT,
  "metadata"     JSONB,
  "createdAt"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "report_moderation_events_reportId_createdAt_idx"
  ON "report_moderation_events"("reportId", "createdAt");
CREATE INDEX "report_moderation_events_actorAdminId_createdAt_idx"
  ON "report_moderation_events"("actorAdminId", "createdAt");

-- Banding atas keputusan moderasi final (G404/G405).
CREATE TABLE "report_appeals" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "reportId"        TEXT NOT NULL REFERENCES "showcase_reports"("id") ON DELETE CASCADE,
  "appellantType"   "AppellantType" NOT NULL,
  "appellantUserId" TEXT NOT NULL,
  "reason"          TEXT NOT NULL,
  "newEvidence"     JSONB NOT NULL,
  "status"          "AppealStatus" NOT NULL DEFAULT 'PENDING',
  "reviewerAdminId" TEXT,
  "decidedAt"       TIMESTAMPTZ(3),
  "decisionNote"    TEXT,
  "createdAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "report_appeals_reportId_status_idx"
  ON "report_appeals"("reportId", "status");
CREATE INDEX "report_appeals_status_createdAt_idx"
  ON "report_appeals"("status", "createdAt");

-- Cluster laporan duplikat (G415).
CREATE TABLE "report_clusters" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "showcaseId"  TEXT NOT NULL,
  "reason"      VARCHAR(100) NOT NULL,
  "reportCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "report_clusters_showcaseId_createdAt_idx"
  ON "report_clusters"("showcaseId", "createdAt");

CREATE TABLE "report_cluster_members" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "clusterId" TEXT NOT NULL REFERENCES "report_clusters"("id") ON DELETE CASCADE,
  "reportId"  TEXT NOT NULL REFERENCES "showcase_reports"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "report_cluster_members_clusterId_reportId_key" UNIQUE ("clusterId", "reportId")
);
CREATE INDEX "report_cluster_members_reportId_idx"
  ON "report_cluster_members"("reportId");

-- Assignment laporan ke admin + skor risiko + SLA (G411, G419).
CREATE TABLE "report_assignments" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "reportId"        TEXT NOT NULL REFERENCES "showcase_reports"("id") ON DELETE CASCADE,
  "assigneeAdminId" TEXT NOT NULL,
  "riskScore"       INTEGER NOT NULL,
  "slaDueAt"        TIMESTAMPTZ(3) NOT NULL,
  "escalated"       BOOLEAN NOT NULL DEFAULT false,
  "assignedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unassignedAt"    TIMESTAMPTZ(3),
  "createdAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "report_assignments_assigneeAdminId_slaDueAt_idx"
  ON "report_assignments"("assigneeAdminId", "slaDueAt");
CREATE INDEX "report_assignments_slaDueAt_idx"
  ON "report_assignments"("slaDueAt");
