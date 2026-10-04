-- POIN 5 (2026-10-04) — BANTUAN TERPUSAT + livechat WEBSOCKET PENUH, gelombang 1 (backend).
--
-- Keputusan desain: model BARU (SupportConversation + SupportMessage), bukan
-- reuse ChatRoom. Alasan:
--   1. ChatRoom terikat semantik commerce (ORDER/INQUIRY, buyer/seller, grace
--      period order, pipeline moderasi Trust & Safety, pesan ephemeral,
--      polling/star/pin) — tidak satu pun berlaku untuk percakapan support.
--   2. Status tidak kompatibel: ChatRoomStatus {ACTIVE, CLOSED} vs alur
--      antrean {WAITING, ASSIGNED, OPEN, CLOSED}.
--   3. Batas otorisasi bersih: mencampur support ke ChatRoom membocorkan
--      percakapan support ke daftar chat user (dan sebaliknya) via API chat.
--   4. Migrasi ini aditif murni — tabel chat yang panas tidak disentuh.
--
-- Perubahan:
--   1. Enum baru: SupportConversationStatus, SupportMessageSenderType,
--      SupportTicketSource.
--   2. Tabel baru: support_conversations, support_messages.
--   3. support_tickets: kolom sourceType, sourceChatRoomId, transcriptText.
--      Sejak POIN 5, tiket HANYA dibuat admin (eskalasi livechat); endpoint
--      user-facing POST /v1/support/tickets dicabut di kode aplikasi.
--   4. NotificationType: nilai baru SUPPORT_AGENT_REPLY (notifikasi ke user
--      saat agen membalas di livechat).

-- 1) Enum baru
CREATE TYPE "SupportConversationStatus" AS ENUM ('WAITING', 'ASSIGNED', 'OPEN', 'CLOSED');
CREATE TYPE "SupportMessageSenderType" AS ENUM ('USER', 'AGENT', 'SYSTEM');
CREATE TYPE "SupportTicketSource" AS ENUM ('APP', 'HELP_SITE', 'CHAT_ESCALATION');

-- 2) Nilai enum notifikasi baru (pola sama seperti KYC_REVOKED, dsb.)
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SUPPORT_AGENT_REPLY';

-- 3) Tabel percakapan support
CREATE TABLE "support_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SupportConversationStatus" NOT NULL DEFAULT 'WAITING',
    "assignedAgentId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "source" "SupportTicketSource" NOT NULL DEFAULT 'APP',
    "subject" VARCHAR(200),
    "priority" BOOLEAN NOT NULL DEFAULT false,
    "closedAt" TIMESTAMP(3),
    "closedByType" "SupportMessageSenderType",
    "closedById" TEXT,
    "rating" INTEGER,
    "ratingComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_conversations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "support_conversations_userId_status_idx" ON "support_conversations"("userId", "status");
-- Antrean agen: WAITING diurutkan prioritas (Kahade+) dulu, lalu FIFO.
CREATE INDEX "support_conversations_status_priority_createdAt_idx" ON "support_conversations"("status", "priority", "createdAt");
CREATE INDEX "support_conversations_assignedAgentId_status_idx" ON "support_conversations"("assignedAgentId", "status");

-- 4) Tabel pesan support
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" "SupportMessageSenderType" NOT NULL,
    "senderUserId" TEXT,
    "senderAdminId" TEXT,
    "content" TEXT,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "support_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_senderAdminId_fkey" FOREIGN KEY ("senderAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "support_messages_conversationId_createdAt_idx" ON "support_messages"("conversationId", "createdAt");

-- 5) Kolom baru di support_tickets
ALTER TABLE "support_tickets" ADD COLUMN "sourceType" "SupportTicketSource" NOT NULL DEFAULT 'APP';
ALTER TABLE "support_tickets" ADD COLUMN "sourceChatRoomId" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "transcriptText" TEXT;

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_sourceChatRoomId_fkey" FOREIGN KEY ("sourceChatRoomId") REFERENCES "support_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "support_tickets_sourceChatRoomId_idx" ON "support_tickets"("sourceChatRoomId");
