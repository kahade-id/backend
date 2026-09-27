-- ============================================================================
-- MIGRASI gap-F-D (observability & kesiapan insiden, G485/G497)
-- Nama migrasi: 202609270604_observability
-- Audit 2026-09-26 — Grup F, worker D.
--
-- APPEND-ONLY: buat folder prisma/migrations/202609270604_observability/
-- berisi file migration.sql ini saat batch deploy berikutnya, lalu jalankan
-- `prisma migrate deploy` + `prisma generate`.
-- Idempoten sebagian: CREATE TYPE memakai IF NOT EXISTS tidak didukung
-- PostgreSQL untuk enum — skrip ini membungkus pembuatan tipe dalam
-- blok DO agar aman dijalankan ulang.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE "AlertSeverity" AS ENUM ('WARNING', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AlertEventStatus" AS ENUM ('RAISED', 'ACKNOWLEDGED', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "IncidentStatus" AS ENUM ('INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "alert_events" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "key"             TEXT NOT NULL UNIQUE,
  "severity"        "AlertSeverity" NOT NULL,
  "message"         TEXT NOT NULL,
  "context"         JSONB,
  "status"          "AlertEventStatus" NOT NULL DEFAULT 'RAISED',
  "raisedAt"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastSeenAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "cooldownUntil"   TIMESTAMPTZ,
  "acknowledgedBy"  TEXT,
  "acknowledgedAt"  TIMESTAMPTZ,
  "resolvedBy"      TEXT,
  "resolvedAt"      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "alert_events_status_lastSeenAt_idx"
  ON "alert_events" ("status", "lastSeenAt");

CREATE TABLE IF NOT EXISTS "incident_logs" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "title"       TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "severity"    "IncidentSeverity" NOT NULL,
  "status"      "IncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
  "component"   TEXT NOT NULL,
  "startedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "resolvedAt"  TIMESTAMPTZ,
  "createdBy"   TEXT,
  "updatedBy"   TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "incident_logs_status_startedAt_idx"
  ON "incident_logs" ("status", "startedAt");
CREATE INDEX IF NOT EXISTS "incident_logs_component_idx"
  ON "incident_logs" ("component");
