-- Add missing SupportTicket / SupportTicketReply tables and enums.
-- These models exist in schema.prisma:2341+ but were never migrated,
-- so /admin/support/tickets fails on prod with "table does not exist".

-- Enums
DO $$ BEGIN
  CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SupportTicketCategory" AS ENUM ('GENERAL', 'ORDER', 'PAYMENT', 'ACCOUNT', 'KYC', 'TECHNICAL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SupportTicketSenderType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tables
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "subject"   VARCHAR(200) NOT NULL,
  "message"   TEXT NOT NULL,
  "category"  "SupportTicketCategory" NOT NULL DEFAULT 'GENERAL',
  "orderId"   TEXT,
  "status"    "SupportTicketStatus"   NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "support_ticket_replies" (
  "id"         TEXT NOT NULL,
  "ticketId"   TEXT NOT NULL,
  "senderId"   TEXT NOT NULL,
  "senderType" "SupportTicketSenderType" NOT NULL DEFAULT 'USER',
  "message"    TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_ticket_replies_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "support_tickets_userId_idx" ON "support_tickets"("userId");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets"("status");
CREATE INDEX IF NOT EXISTS "support_ticket_replies_ticketId_idx" ON "support_ticket_replies"("ticketId");

-- Foreign keys
DO $$ BEGIN
  ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "support_ticket_replies"
    ADD CONSTRAINT "support_ticket_replies_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
