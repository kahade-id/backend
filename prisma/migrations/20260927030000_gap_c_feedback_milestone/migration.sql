-- Migration: GAP-C feedback workflow + order escrow milestone (G151–G200).
-- Prinsip: append-only. Tidak ada kolom yang dihapus/diubah tipenya.
-- Order satu tahap existing TIDAK berubah perilaku (milestone = ekstensi opt-in).

-- 1. Enum baru.
CREATE TYPE "FeedbackStatus" AS ENUM ('NEW', 'IN_REVIEW', 'ACTIONED', 'CLOSED');
CREATE TYPE "FeedbackCloseReason" AS ENUM ('RESOLVED', 'DUPLICATE', 'NOT_ACTIONABLE', 'SPAM', 'OUT_OF_SCOPE', 'OTHER');
CREATE TYPE "FeedbackRisk" AS ENUM ('NONE', 'SECURITY_RISK', 'FRAUD_RISK');
CREATE TYPE "FeedbackAuditAction" AS ENUM ('STATUS_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'TAG_ADDED', 'TAG_REMOVED', 'NOTE_ADDED', 'REPLY_SENT', 'CONTACTED', 'ESCALATED', 'RISK_FLAGGED', 'SLA_UPDATED', 'CLOSED', 'REOPENED');
CREATE TYPE "MilestoneStatus" AS ENUM ('DRAFT', 'AWAITING_ACTIVATION', 'SUBMITTED', 'REVISION_REQUESTED', 'ACCEPTED', 'RELEASED', 'CANCELLED', 'DISPUTED');
CREATE TYPE "MilestoneEventType" AS ENUM ('CREATED', 'UPDATED', 'ACTIVATED', 'SUBMITTED', 'REVISION_REQUESTED', 'ACCEPTED', 'RELEASED', 'DEADLINE_EXTENDED', 'CANCELLED', 'DISPUTE_OPENED', 'DISPUTE_CLOSED', 'REMINDER_SENT', 'CHANGE_REQUESTED', 'CHANGE_APPROVED');
CREATE TYPE "MilestoneActorType" AS ENUM ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM');

-- 2. Kolom aditif di tabel feedback (workflow G151–G175).
ALTER TABLE "feedback" ADD COLUMN "status" "FeedbackStatus" NOT NULL DEFAULT 'NEW';
ALTER TABLE "feedback" ADD COLUMN "assigneeId" TEXT;
ALTER TABLE "feedback" ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "feedback" ADD COLUMN "impactLabel" VARCHAR(50);
ALTER TABLE "feedback" ADD COLUMN "contactConsent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "feedback" ADD COLUMN "appVersion" VARCHAR(32);
ALTER TABLE "feedback" ADD COLUMN "slaDueAt" TIMESTAMPTZ(3);
ALTER TABLE "feedback" ADD COLUMN "riskFlag" "FeedbackRisk" NOT NULL DEFAULT 'NONE';
ALTER TABLE "feedback" ADD COLUMN "closedReason" "FeedbackCloseReason";
ALTER TABLE "feedback" ADD COLUMN "closedAt" TIMESTAMPTZ(3);
ALTER TABLE "feedback" ADD COLUMN "redactedAt" TIMESTAMPTZ(3);
ALTER TABLE "feedback" ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "feedback_status_createdAt_idx" ON "feedback"("status", "createdAt");
CREATE INDEX "feedback_assigneeId_idx" ON "feedback"("assigneeId");
CREATE INDEX "feedback_riskFlag_idx" ON "feedback"("riskFlag");

-- 3. Tabel workflow feedback.
CREATE TABLE "feedback_assignments" (
  "id" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "assignedBy" TEXT,
  "note" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_assignments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_assignments_feedbackId_createdAt_idx" ON "feedback_assignments"("feedbackId", "createdAt");
CREATE INDEX "feedback_assignments_adminId_idx" ON "feedback_assignments"("adminId");
ALTER TABLE "feedback_assignments" ADD CONSTRAINT "feedback_assignments_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feedback_internal_notes" (
  "id" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_internal_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_internal_notes_feedbackId_createdAt_idx" ON "feedback_internal_notes"("feedbackId", "createdAt");
ALTER TABLE "feedback_internal_notes" ADD CONSTRAINT "feedback_internal_notes_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feedback_replies" (
  "id" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_replies_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_replies_feedbackId_createdAt_idx" ON "feedback_replies"("feedbackId", "createdAt");
ALTER TABLE "feedback_replies" ADD CONSTRAINT "feedback_replies_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feedback_audit" (
  "id" TEXT NOT NULL,
  "feedbackId" TEXT NOT NULL,
  "adminId" TEXT,
  "action" "FeedbackAuditAction" NOT NULL,
  "detail" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_audit_feedbackId_createdAt_idx" ON "feedback_audit"("feedbackId", "createdAt");
CREATE INDEX "feedback_audit_action_createdAt_idx" ON "feedback_audit"("action", "createdAt");
ALTER TABLE "feedback_audit" ADD CONSTRAINT "feedback_audit_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "feedback"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feedback_sla_rules" (
  "id" TEXT NOT NULL,
  "category" VARCHAR(100) NOT NULL,
  "hours" INTEGER NOT NULL,
  "isCritical" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "feedback_sla_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feedback_sla_rules_category_key" UNIQUE ("category")
);

-- 4. Tabel milestone escrow (G176–G200).
CREATE TABLE "order_milestones" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "amount" BIGINT NOT NULL,
  "sellerAmount" BIGINT NOT NULL,
  "buyerAmount" BIGINT NOT NULL,
  "feeAmount" BIGINT NOT NULL,
  "status" "MilestoneStatus" NOT NULL DEFAULT 'DRAFT',
  "deadline" TIMESTAMPTZ(3),
  "reviewDeadline" TIMESTAMPTZ(3),
  "submittedAt" TIMESTAMPTZ(3),
  "submittedById" TEXT,
  "acceptedAt" TIMESTAMPTZ(3),
  "releasedAt" TIMESTAMPTZ(3),
  "releasedTxId" TEXT,
  "revisionRounds" INTEGER NOT NULL DEFAULT 0,
  "maxRevisionRounds" INTEGER NOT NULL DEFAULT 2,
  "escrowHeld" BIGINT NOT NULL DEFAULT 0,
  "changeRequest" JSONB,
  "buyerApprovedChange" BOOLEAN NOT NULL DEFAULT false,
  "sellerApprovedChange" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "order_milestones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_milestones_orderId_seq_key" UNIQUE ("orderId", "seq"),
  CONSTRAINT "order_milestones_releasedTxId_key" UNIQUE ("releasedTxId"),
  CONSTRAINT "order_milestones_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "order_milestones_seller_amount_nonneg" CHECK ("sellerAmount" >= 0),
  CONSTRAINT "order_milestones_buyer_amount_positive" CHECK ("buyerAmount" > 0),
  CONSTRAINT "order_milestones_fee_amount_nonneg" CHECK ("feeAmount" >= 0),
  CONSTRAINT "order_milestones_escrow_held_nonneg" CHECK ("escrowHeld" >= 0)
);
CREATE INDEX "order_milestones_orderId_status_idx" ON "order_milestones"("orderId", "status");
ALTER TABLE "order_milestones" ADD CONSTRAINT "order_milestones_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "milestone_evidence" (
  "id" TEXT NOT NULL,
  "milestoneId" TEXT NOT NULL,
  "fileKey" VARCHAR(500) NOT NULL,
  "fileType" VARCHAR(80),
  "caption" VARCHAR(280),
  "uploadedById" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "milestone_evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "milestone_evidence_milestoneId_createdAt_idx" ON "milestone_evidence"("milestoneId", "createdAt");
ALTER TABLE "milestone_evidence" ADD CONSTRAINT "milestone_evidence_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "order_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "milestone_events" (
  "id" TEXT NOT NULL,
  "milestoneId" TEXT NOT NULL,
  "actorType" "MilestoneActorType" NOT NULL,
  "actorId" TEXT,
  "eventType" "MilestoneEventType" NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "milestone_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "milestone_events_milestoneId_createdAt_idx" ON "milestone_events"("milestoneId", "createdAt");
CREATE INDEX "milestone_events_eventType_createdAt_idx" ON "milestone_events"("eventType", "createdAt");
ALTER TABLE "milestone_events" ADD CONSTRAINT "milestone_events_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "order_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Sengketa dapat dibatasi ke milestone (G190). Null = order satu tahap.
ALTER TABLE "disputes" ADD COLUMN "milestoneId" TEXT;
CREATE INDEX "disputes_milestoneId_idx" ON "disputes"("milestoneId");

-- 6. Tipe ledger baru untuk release per tahap (idempoten).
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'MILESTONE_RELEASE';

-- 6b. Tipe notifikasi milestone (G193).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MILESTONE_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MILESTONE_REVISION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MILESTONE_ACCEPTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MILESTONE_RELEASED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MILESTONE_DEADLINE_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MILESTONE_CANCELLED';

-- 7. Backfill G197: order lama (terminal) mendapat satu milestone sintetis
--    TANPA mengubah saldo: escrowHeld = 0, status turunan dari status order.
--    Order in-flight TIDAK disentuh (tetap alur satu tahap legacy).
INSERT INTO "order_milestones"
  ("id", "orderId", "seq", "title", "amount", "sellerAmount", "buyerAmount", "feeAmount", "status", "escrowHeld", "createdAt", "updatedAt")
SELECT
  'legacy-' || o."id",
  o."id",
  1,
  'Tahap tunggal (migrasi)',
  o."orderValue",
  o."sellerReceiveAmount",
  o."buyerPayAmount",
  o."feeAmount",
  CASE WHEN o."status" = 'COMPLETED' THEN 'RELEASED'::"MilestoneStatus" ELSE 'CANCELLED'::"MilestoneStatus" END,
  0,
  o."createdAt",
  o."updatedAt"
FROM "orders" o
WHERE o."status" IN ('COMPLETED', 'CANCELLED')
  AND NOT EXISTS (SELECT 1 FROM "order_milestones" m WHERE m."orderId" = o."id");
