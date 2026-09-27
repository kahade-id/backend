-- ============================================================
-- GAP-F (G452-G475): Public Partner API & outbound webhooks.
-- Migration name: 202609270603_partner_api
-- Append-only. Jalankan SETELAH fragment gap-F-C-schema.prisma di-merge
-- ke prisma/schema.prisma (atau generate via `prisma migrate dev`).
-- Catatan: jika prisma migrate dijalankan dari schema yang sudah di-merge,
-- file ini hanya referensi — JANGAN apply manual bila drift terdeteksi.
-- ============================================================

CREATE TYPE "PartnerClientStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "PartnerWebhookDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DLQ');

CREATE TABLE "partner_api_clients" (
  "id"                   TEXT NOT NULL,
  "orgName"              VARCHAR(120) NOT NULL,
  "ownerUserId"          TEXT,
  "status"               "PartnerClientStatus" NOT NULL DEFAULT 'ACTIVE',
  "isSandbox"            BOOLEAN NOT NULL DEFAULT false,
  "rateLimitPerMinute"   INTEGER NOT NULL DEFAULT 100,
  "quotaPerDay"          INTEGER NOT NULL DEFAULT 10000,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_api_clients_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_api_clients_status_idx" ON "partner_api_clients"("status");
CREATE INDEX "partner_api_clients_ownerUserId_idx" ON "partner_api_clients"("ownerUserId");

CREATE TABLE "partner_api_keys" (
  "id"           TEXT NOT NULL,
  "clientId"     TEXT NOT NULL,
  "keyPrefix"    VARCHAR(16) NOT NULL,
  "keyHash"      VARCHAR(255) NOT NULL,
  "scopes"       TEXT[] NOT NULL,
  "name"         VARCHAR(80),
  "expiresAt"    TIMESTAMP(3),
  "rotatedFromId" TEXT,
  "validUntil"   TIMESTAMP(3),
  "revokedAt"    TIMESTAMP(3),
  "revokeReason" VARCHAR(280),
  "lastUsedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_api_keys_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_api_keys_clientId_idx" ON "partner_api_keys"("clientId");
CREATE INDEX "partner_api_keys_keyPrefix_idx" ON "partner_api_keys"("keyPrefix");
ALTER TABLE "partner_api_keys"
  ADD CONSTRAINT "partner_api_keys_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "partner_api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_api_keys"
  ADD CONSTRAINT "partner_api_keys_rotatedFromId_fkey"
  FOREIGN KEY ("rotatedFromId") REFERENCES "partner_api_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "partner_api_usage" (
  "id"         TEXT NOT NULL,
  "clientId"   TEXT NOT NULL,
  "date"       DATE NOT NULL,
  "endpoint"   VARCHAR(200) NOT NULL,
  "count"      INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "partner_api_usage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_api_usage_clientId_date_endpoint_key"
  ON "partner_api_usage"("clientId", "date", "endpoint");
CREATE INDEX "partner_api_usage_clientId_date_idx" ON "partner_api_usage"("clientId", "date");
ALTER TABLE "partner_api_usage"
  ADD CONSTRAINT "partner_api_usage_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "partner_api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "partner_webhook_endpoints" (
  "id"                 TEXT NOT NULL,
  "clientId"           TEXT NOT NULL,
  "url"                VARCHAR(500) NOT NULL,
  "events"             TEXT[] NOT NULL,
  "secretEnc"          TEXT NOT NULL,
  "isActive"           BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt"         TIMESTAMP(3),
  "challengeToken"     VARCHAR(128),
  "challengeIssuedAt"  TIMESTAMP(3),
  "lastDeliveryAt"     TIMESTAMP(3),
  "lastDeliveryStatus" VARCHAR(16),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_webhook_endpoints_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_webhook_endpoints_clientId_idx" ON "partner_webhook_endpoints"("clientId");
ALTER TABLE "partner_webhook_endpoints"
  ADD CONSTRAINT "partner_webhook_endpoints_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "partner_api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "partner_webhook_deliveries" (
  "id"           TEXT NOT NULL,
  "endpointId"   TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "eventType"    VARCHAR(64) NOT NULL,
  "payload"      JSONB NOT NULL,
  "attempt"      INTEGER NOT NULL DEFAULT 0,
  "status"       "PartnerWebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "nextRetryAt"  TIMESTAMP(3),
  "lastError"    VARCHAR(500),
  "responseCode" INTEGER,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"  TIMESTAMP(3),
  CONSTRAINT "partner_webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_webhook_deliveries_eventId_key" ON "partner_webhook_deliveries"("eventId");
CREATE INDEX "partner_webhook_deliveries_endpointId_status_idx"
  ON "partner_webhook_deliveries"("endpointId", "status");
CREATE INDEX "partner_webhook_deliveries_status_nextRetryAt_idx"
  ON "partner_webhook_deliveries"("status", "nextRetryAt");
ALTER TABLE "partner_webhook_deliveries"
  ADD CONSTRAINT "partner_webhook_deliveries_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "partner_webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "partner_audit_logs" (
  "id"          TEXT NOT NULL,
  "adminId"     TEXT NOT NULL,
  "action"      VARCHAR(64) NOT NULL,
  "targetType"  VARCHAR(64),
  "targetId"    TEXT,
  "description" TEXT NOT NULL,
  "before"      JSONB,
  "after"       JSONB,
  "ipAddress"   VARCHAR(64) NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_audit_logs_targetId_targetType_idx" ON "partner_audit_logs"("targetId", "targetType");
CREATE INDEX "partner_audit_logs_createdAt_idx" ON "partner_audit_logs"("createdAt");
CREATE INDEX "partner_audit_logs_action_idx" ON "partner_audit_logs"("action");
