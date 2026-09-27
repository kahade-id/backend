-- GAP-A passkey/WebAuthn (G026-G050).
-- Tabel kredensial passkey + nilai enum audit baru (append-only).
-- Idempoten: aman dijalankan ulang.

CREATE TABLE IF NOT EXISTS "passkey_credentials" (
  "id"            TEXT        NOT NULL,
  "userId"        TEXT        NOT NULL,
  "credentialId"  VARCHAR(255) NOT NULL,
  "publicKey"     TEXT        NOT NULL,
  "counter"       BIGINT      NOT NULL,
  "deviceName"    VARCHAR(100) NOT NULL,
  "deviceType"    VARCHAR(20),
  "backedUp"      BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"    TIMESTAMPTZ(6),
  "revokedAt"     TIMESTAMPTZ(6),
  CONSTRAINT "passkey_credentials_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'passkey_credentials_userId_fkey'
  ) THEN
    ALTER TABLE "passkey_credentials"
      ADD CONSTRAINT "passkey_credentials_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credentials_credentialId_key"
  ON "passkey_credentials"("credentialId");
CREATE INDEX IF NOT EXISTS "passkey_credentials_userId_revokedAt_idx"
  ON "passkey_credentials"("userId", "revokedAt");

-- Nilai enum audit baru (append-only; ADD VALUE tidak bisa di-rollback dalam transaksi,
-- sehingga IF NOT EXISTS dipakai agar migrasi idempoten).
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'PASSKEY_REGISTERED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'PASSKEY_USED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'PASSKEY_FAILED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'PASSKEY_REVOKED';
ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'PASSKEY_RENAMED';
