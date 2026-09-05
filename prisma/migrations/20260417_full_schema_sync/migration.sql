-- Comprehensive idempotent schema sync.
-- Brings DB up to date with prisma/schema.prisma. Every statement is wrapped
-- with IF NOT EXISTS / DO $$ EXCEPTION blocks so the migration can run on:
--   * a fresh DB (init + later migrations applied)
--   * production (most pieces already there from manual db push, partial only)
-- Adds: DisputeCallStatus enum, missing AuditAction/NotificationType/UserAuditAction
-- enum values, mutual_resolution_proposals/dispute_messages/dispute_calls/
-- user_showcases tables, chat_messages.replyToId, dispute_decisions metric
-- columns, webhook_logs.updatedAt, plus required indexes/FKs.

-- ============================================================
-- 1. NEW ENUM
-- ============================================================
DO $$ BEGIN
  CREATE TYPE "DisputeCallStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'ENDED', 'REJECTED', 'EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 2. ENUM VALUE ADDITIONS (each must be its own statement on PG <12)
-- ============================================================
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_LOGOUT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BADGE_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BADGE_REVOKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BROADCAST_SENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'USER_PASSWORD_RESET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'REPORT_RESOLVED';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_DELIVERED';

ALTER TYPE "UserAuditAction" ADD VALUE IF NOT EXISTS 'REGISTER';

-- ============================================================
-- 3. NEW TABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS "mutual_resolution_proposals" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "proposedBy" TEXT NOT NULL,
    "proposerRole" "ActorType" NOT NULL,
    "buyerPercent" INTEGER NOT NULL,
    "sellerPercent" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mutual_resolution_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dispute_messages" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "adminId" TEXT,
    "message" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "user_showcases" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "imageUrl" TEXT,
    "priceMin" BIGINT,
    "priceMax" BIGINT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_showcases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dispute_calls" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "DisputeCallStatus" NOT NULL DEFAULT 'REQUESTED',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    "maxDurationSeconds" INTEGER NOT NULL DEFAULT 900,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dispute_calls_pkey" PRIMARY KEY ("id")
);

-- ============================================================
-- 4. ADDITIONAL COLUMNS
-- ============================================================
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "replyToId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phoneNumberHash" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "disputes" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "dispute_decisions" ADD COLUMN IF NOT EXISTS "timeToFirstResponseMs" BIGINT;
ALTER TABLE "dispute_decisions" ADD COLUMN IF NOT EXISTS "totalResolutionTimeMs" BIGINT;

-- webhook_logs.updatedAt: ensure column exists, backfill NULLs, enforce NOT NULL
ALTER TABLE "webhook_logs" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);
UPDATE "webhook_logs" SET "updatedAt" = COALESCE("createdAt", CURRENT_TIMESTAMP) WHERE "updatedAt" IS NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='webhook_logs'
      AND column_name='updatedAt' AND is_nullable='YES'
  ) THEN
    ALTER TABLE "webhook_logs" ALTER COLUMN "updatedAt" SET NOT NULL;
  END IF;
END $$;

-- ============================================================
-- 5. COLUMN ALTERATIONS (defensive — only if differs)
-- ============================================================
ALTER TABLE "orders" ALTER COLUMN "deliveryDeadlineDays" SET DEFAULT 3;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='passwordChangedAt' AND is_nullable='NO'
  ) THEN
    ALTER TABLE "users" ALTER COLUMN "passwordChangedAt" DROP NOT NULL;
    ALTER TABLE "users" ALTER COLUMN "passwordChangedAt" DROP DEFAULT;
  END IF;
END $$;

-- ============================================================
-- 6. INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS "mutual_resolution_proposals_disputeId_idx" ON "mutual_resolution_proposals"("disputeId");
CREATE INDEX IF NOT EXISTS "mutual_resolution_proposals_disputeId_status_idx" ON "mutual_resolution_proposals"("disputeId", "status");
CREATE INDEX IF NOT EXISTS "dispute_messages_disputeId_idx" ON "dispute_messages"("disputeId");
CREATE INDEX IF NOT EXISTS "dispute_messages_disputeId_createdAt_idx" ON "dispute_messages"("disputeId", "createdAt");
CREATE INDEX IF NOT EXISTS "dispute_messages_adminId_idx" ON "dispute_messages"("adminId");
CREATE INDEX IF NOT EXISTS "user_showcases_userId_isActive_sortOrder_idx" ON "user_showcases"("userId", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "dispute_calls_disputeId_idx" ON "dispute_calls"("disputeId");
CREATE INDEX IF NOT EXISTS "dispute_calls_disputeId_status_idx" ON "dispute_calls"("disputeId", "status");
CREATE INDEX IF NOT EXISTS "dispute_calls_requestedById_idx" ON "dispute_calls"("requestedById");
CREATE INDEX IF NOT EXISTS "notifications_sentAt_idx" ON "notifications"("sentAt");
CREATE INDEX IF NOT EXISTS "orders_orderLinkId_idx" ON "orders"("orderLinkId");
CREATE INDEX IF NOT EXISTS "user_devices_pushToken_idx" ON "user_devices"("pushToken");
CREATE UNIQUE INDEX IF NOT EXISTS "users_phoneNumberHash_key" ON "users"("phoneNumberHash");

-- referral_rewards composite unique replaces the old single-column unique/index
DROP INDEX IF EXISTS "referral_rewards_triggeredByOrderId_idx";
DROP INDEX IF EXISTS "referral_rewards_triggeredByOrderId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "referral_rewards_triggeredByOrderId_referrerId_key" ON "referral_rewards"("triggeredByOrderId", "referrerId");

-- Stale indexes that no longer exist in schema
DROP INDEX IF EXISTS "order_links_token_idx";
DROP INDEX IF EXISTS "idx_user_email_verified";
DROP INDEX IF EXISTS "idx_users_dateOfBirth";

-- ============================================================
-- 7. FOREIGN KEYS (each guarded — Postgres doesn't have IF NOT EXISTS for FKs)
-- ============================================================
DO $$ BEGIN
  ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_replyToId_fkey"
    FOREIGN KEY ("replyToId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "mutual_resolution_proposals" ADD CONSTRAINT "mutual_resolution_proposals_disputeId_fkey"
    FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "mutual_resolution_proposals" ADD CONSTRAINT "mutual_resolution_proposals_proposedBy_fkey"
    FOREIGN KEY ("proposedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "order_links" ADD CONSTRAINT "order_links_acceptedById_fkey"
    FOREIGN KEY ("acceptedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_submittedBy_fkey"
    FOREIGN KEY ("submittedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "rating_replies" ADD CONSTRAINT "rating_replies_replierId_fkey"
    FOREIGN KEY ("replierId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "scheduled_withdrawals" ADD CONSTRAINT "scheduled_withdrawals_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "scheduled_withdrawals" ADD CONSTRAINT "scheduled_withdrawals_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "transaction_templates" ADD CONSTRAINT "transaction_templates_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_disputeId_fkey"
    FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_senderId_fkey"
    FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "user_showcases" ADD CONSTRAINT "user_showcases_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_calls" ADD CONSTRAINT "dispute_calls_disputeId_fkey"
    FOREIGN KEY ("disputeId") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "dispute_calls" ADD CONSTRAINT "dispute_calls_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
