-- Migration: GAP-A account deletion — status penghapusan & riwayat transisi.
--
-- Tabel baru (append-only, tidak mengubah tabel existing):
--   - account_deletion_requests: permintaan penghapusan akun + masa tenggang 30 hari
--   - account_deletion_status_history: audit transisi status (append-only)
--   - enum DeletionRequestStatus: REQUESTED | PENDING | CANCELLED | PURGED | ON_HOLD
-- BELUM DI-APPLY — koordinator apply saat deploy (prisma migrate deploy).

CREATE TYPE "DeletionRequestStatus" AS ENUM ('REQUESTED', 'PENDING', 'CANCELLED', 'PURGED', 'ON_HOLD');

CREATE TABLE "account_deletion_requests" (
    "id"               TEXT    NOT NULL,
    "userId"           TEXT    NOT NULL,
    "referenceCode"    TEXT    NOT NULL,
    "status"           "DeletionRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "idempotencyKey"   TEXT    NOT NULL,
    "requestedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purgeAt"          TIMESTAMP(3) NOT NULL,
    "cancelledAt"      TIMESTAMP(3),
    "cancelReason"     TEXT,
    "purgedAt"         TIMESTAMP(3),
    "legalHoldReason"  TEXT,
    "reminder7dSent"   BOOLEAN NOT NULL DEFAULT false,
    "reminder1dSent"   BOOLEAN NOT NULL DEFAULT false,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_deletion_status_history" (
    "id"          TEXT    NOT NULL,
    "requestId"   TEXT    NOT NULL,
    "fromStatus"  "DeletionRequestStatus",
    "toStatus"    "DeletionRequestStatus" NOT NULL,
    "actorUserId" TEXT,
    "actorType"   VARCHAR(16) NOT NULL,
    "reason"      VARCHAR(500),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_deletion_status_history_pkey" PRIMARY KEY ("id")
);

-- Backfill hanya menandai perubahan skema; TIDAK membuat row data (lihat G072:
-- row untuk user legacy dibuat saat purge worker menemukannya, bukan migrasi massal).

CREATE UNIQUE INDEX "account_deletion_requests_referenceCode_key"
    ON "account_deletion_requests"("referenceCode");
CREATE UNIQUE INDEX "account_deletion_requests_idempotencyKey_key"
    ON "account_deletion_requests"("idempotencyKey");
CREATE INDEX "account_deletion_requests_userId_status_idx"
    ON "account_deletion_requests"("userId", "status");
CREATE INDEX "account_deletion_requests_status_purgeAt_idx"
    ON "account_deletion_requests"("status", "purgeAt");
CREATE INDEX "account_deletion_status_history_requestId_createdAt_idx"
    ON "account_deletion_status_history"("requestId", "createdAt");

ALTER TABLE "account_deletion_requests"
    ADD CONSTRAINT "account_deletion_requests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "account_deletion_status_history"
    ADD CONSTRAINT "account_deletion_status_history_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "account_deletion_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
