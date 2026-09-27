-- GAP-E admin ops (G276-G400): SLA config, temuan rekonsiliasi, versi kampanye, sesi admin, akses darurat, audit ekspor, handoff.

-- Enum baru
CREATE TYPE "ReconciliationFindingStatus" AS ENUM ('NEW', 'INVESTIGATING', 'RESOLVED', 'ACCEPTED');

-- Nilai AuditAction baru (append-only)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SLA_CONFIG_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KYC_REVIEW_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECONCILIATION_FINDING_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'RECONCILIATION_FINDING_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MANUAL_LEDGER_CORRECTION';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_DELETED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PAUSE_REASON_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_SESSION_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMERGENCY_ACCESS_GRANTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'EMERGENCY_ACCESS_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_SUSPENDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_REACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CASE_HANDOFF_CREATED';

-- Kolom SLA di kyc_requests
ALTER TABLE "kyc_requests" ADD COLUMN IF NOT EXISTS "sla_started_at" TIMESTAMPTZ(6);
ALTER TABLE "kyc_requests" ADD COLUMN IF NOT EXISTS "sla_paused_at" TIMESTAMPTZ(6);
ALTER TABLE "kyc_requests" ADD COLUMN IF NOT EXISTS "sla_paused_accum_ms" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "kyc_requests" ADD COLUMN IF NOT EXISTS "sla_breached_at" TIMESTAMPTZ(6);
ALTER TABLE "kyc_requests" ADD COLUMN IF NOT EXISTS "assigned_reviewer_id" TEXT;

-- GAP-E G320: kolom reviewer-tertugaskan untuk verifikasi badan usaha
-- (selaras dengan kyc_requests.assigned_reviewer_id di atas).
ALTER TABLE "business_verifications" ADD COLUMN IF NOT EXISTS "assigned_reviewer_id" TEXT;

-- operational_sla_configs
CREATE TABLE IF NOT EXISTS "operational_sla_configs" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "sla_hours" INTEGER NOT NULL,
    "use_business_hours" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" TEXT,
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "operational_sla_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "operational_sla_configs_scope_key" ON "operational_sla_configs"("scope");

-- operational_sla_config_audits
CREATE TABLE IF NOT EXISTS "operational_sla_config_audits" (
    "id" TEXT NOT NULL,
    "config_id" TEXT NOT NULL,
    "sla_hours" INTEGER NOT NULL,
    "use_business_hours" BOOLEAN NOT NULL,
    "changed_by" TEXT,
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "operational_sla_config_audits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "operational_sla_config_audits_config_id_idx" ON "operational_sla_config_audits"("config_id");
ALTER TABLE "operational_sla_config_audits" ADD CONSTRAINT "operational_sla_config_audits_config_id_fkey" FOREIGN KEY ("config_id") REFERENCES "operational_sla_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- kyc_review_assignments
CREATE TABLE IF NOT EXISTS "kyc_review_assignments" (
    "id" TEXT NOT NULL,
    "kyc_request_id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "assigned_by" TEXT NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "kyc_review_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "kyc_review_assignments_kyc_request_id_idx" ON "kyc_review_assignments"("kyc_request_id");
CREATE INDEX IF NOT EXISTS "kyc_review_assignments_admin_id_idx" ON "kyc_review_assignments"("admin_id");

-- reconciliation_findings
CREATE TABLE IF NOT EXISTS "reconciliation_findings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "recorded_balance" BIGINT NOT NULL,
    "computed_balance" BIGINT NOT NULL,
    "difference" BIGINT NOT NULL,
    "violated_invariants" TEXT[] NOT NULL,
    "status" "ReconciliationFindingStatus" NOT NULL DEFAULT 'NEW',
    "batch_id" TEXT,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "reconciliation_findings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "reconciliation_findings_status_idx" ON "reconciliation_findings"("status");
CREATE INDEX IF NOT EXISTS "reconciliation_findings_user_id_idx" ON "reconciliation_findings"("user_id");
CREATE INDEX IF NOT EXISTS "reconciliation_findings_batch_id_idx" ON "reconciliation_findings"("batch_id");

-- campaign_versions
CREATE TABLE IF NOT EXISTS "campaign_versions" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "changed_by" TEXT,
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "campaign_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_versions_campaign_id_version_key" ON "campaign_versions"("campaign_id", "version");
CREATE INDEX IF NOT EXISTS "campaign_versions_campaign_id_idx" ON "campaign_versions"("campaign_id");
ALTER TABLE "campaign_versions" ADD CONSTRAINT "campaign_versions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- admin_sessions
CREATE TABLE IF NOT EXISTS "admin_sessions" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" TEXT,
    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "admin_sessions_admin_id_idx" ON "admin_sessions"("admin_id");
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- emergency_access_grants
CREATE TABLE IF NOT EXISTS "emergency_access_grants" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "granted_by" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "emergency_access_grants_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "emergency_access_grants_admin_id_idx" ON "emergency_access_grants"("admin_id");
ALTER TABLE "emergency_access_grants" ADD CONSTRAINT "emergency_access_grants_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- user_export_audits
CREATE TABLE IF NOT EXISTS "user_export_audits" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "filters" JSONB,
    "columns" TEXT[] NOT NULL,
    "row_count" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_export_audits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "user_export_audits_admin_id_idx" ON "user_export_audits"("admin_id");
ALTER TABLE "user_export_audits" ADD CONSTRAINT "user_export_audits_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- admin_case_handoffs
CREATE TABLE IF NOT EXISTS "admin_case_handoffs" (
    "id" TEXT NOT NULL,
    "case_type" TEXT NOT NULL,
    "case_id" TEXT NOT NULL,
    "from_admin_id" TEXT NOT NULL,
    "to_admin_id" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_case_handoffs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "admin_case_handoffs_case_type_case_id_idx" ON "admin_case_handoffs"("case_type", "case_id");
CREATE INDEX IF NOT EXISTS "admin_case_handoffs_to_admin_id_idx" ON "admin_case_handoffs"("to_admin_id");

-- GAP-E G393: alert login admin dari perangkat/lokasi baru
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_NEW_DEVICE_LOGIN';
