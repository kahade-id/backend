-- Batch 43 BE-CHAT (2026-10-02): fitur chat — additive-only.
-- Hanya kolom/tabel/enum/index BARU; tidak mengubah atau menghapus yang sudah ada.
-- Bukan bagian financial core (tidak menyentuh order/wallet/escrow/fee).
--
-- 1. ChatMessageType: nilai baru LOCATION, PRODUCT_CARD, ORDER_CARD.
-- 2. Enum baru DmPolicy (EVERYONE/FOLLOWING/NONE) + kolom privacy_settings.
--    (hideReadReceipts, dmPolicy) — default EVERYONE/false agar perilaku lama tetap.
-- 3. chat_messages: kolom pesan sementara/sekali-lihat (ephemeralTtlSeconds,
--    expiresAt, viewOnce, viewOnceViewedAt), lokasi (locationLat/Lng/Label),
--    snapshot kartu (cardSnapshot JSONB).
-- 4. Tabel baru: chat_starred_messages, chat_polls, chat_poll_votes,
--    chat_pinned_rooms, chat_reply_templates.

-- 1. Nilai enum baru untuk tipe pesan
ALTER TYPE "ChatMessageType" ADD VALUE IF NOT EXISTS 'LOCATION';
ALTER TYPE "ChatMessageType" ADD VALUE IF NOT EXISTS 'PRODUCT_CARD';
ALTER TYPE "ChatMessageType" ADD VALUE IF NOT EXISTS 'ORDER_CARD';

-- 2. Enum kebijakan DM + kolom privasi chat
CREATE TYPE "DmPolicy" AS ENUM ('EVERYONE', 'FOLLOWING', 'NONE');

ALTER TABLE "privacy_settings" ADD COLUMN "hideReadReceipts" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "privacy_settings" ADD COLUMN "dmPolicy" "DmPolicy" NOT NULL DEFAULT 'EVERYONE';

-- 3. Kolom baru chat_messages
ALTER TABLE "chat_messages" ADD COLUMN "ephemeralTtlSeconds" INTEGER;
ALTER TABLE "chat_messages" ADD COLUMN "expiresAt" TIMESTAMP(3);
ALTER TABLE "chat_messages" ADD COLUMN "viewOnce" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_messages" ADD COLUMN "viewOnceViewedAt" TIMESTAMP(3);
ALTER TABLE "chat_messages" ADD COLUMN "locationLat" DOUBLE PRECISION;
ALTER TABLE "chat_messages" ADD COLUMN "locationLng" DOUBLE PRECISION;
ALTER TABLE "chat_messages" ADD COLUMN "locationLabel" VARCHAR(200);
ALTER TABLE "chat_messages" ADD COLUMN "cardSnapshot" JSONB;

CREATE INDEX "chat_messages_expiresAt_idx"
  ON "chat_messages"("expiresAt")
  WHERE "expiresAt" IS NOT NULL;

-- 4a. Pesan berbintang (per user per room)
CREATE TABLE "chat_starred_messages" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_starred_messages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_starred_messages_userId_messageId_key"
  ON "chat_starred_messages"("userId", "messageId");
CREATE INDEX "chat_starred_messages_userId_roomId_idx"
  ON "chat_starred_messages"("userId", "roomId");
ALTER TABLE "chat_starred_messages" ADD CONSTRAINT "chat_starred_messages_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_starred_messages" ADD CONSTRAINT "chat_starred_messages_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_starred_messages" ADD CONSTRAINT "chat_starred_messages_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4b. Polling/voting per room
CREATE TABLE "chat_polls" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "question" VARCHAR(300) NOT NULL,
  "options" JSONB NOT NULL,
  "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
  "deadline" TIMESTAMP(3),
  "isClosed" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_polls_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "chat_polls_roomId_createdAt_idx"
  ON "chat_polls"("roomId", "createdAt");
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_polls" ADD CONSTRAINT "chat_polls_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_poll_votes" (
  "id" TEXT NOT NULL,
  "pollId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "optionIndex" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_poll_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_poll_votes_pollId_userId_optionIndex_key"
  ON "chat_poll_votes"("pollId", "userId", "optionIndex");
CREATE INDEX "chat_poll_votes_pollId_idx"
  ON "chat_poll_votes"("pollId");
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_pollId_fkey"
  FOREIGN KEY ("pollId") REFERENCES "chat_polls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_poll_votes" ADD CONSTRAINT "chat_poll_votes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4c. Pin room tersinkron backend (per user)
CREATE TABLE "chat_pinned_rooms" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_pinned_rooms_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_pinned_rooms_userId_roomId_key"
  ON "chat_pinned_rooms"("userId", "roomId");
CREATE INDEX "chat_pinned_rooms_userId_position_idx"
  ON "chat_pinned_rooms"("userId", "position");
ALTER TABLE "chat_pinned_rooms" ADD CONSTRAINT "chat_pinned_rooms_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "chat_pinned_rooms" ADD CONSTRAINT "chat_pinned_rooms_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4d. Template balasan cepat "/" (per user)
CREATE TABLE "chat_reply_templates" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "shortcut" VARCHAR(32) NOT NULL,
  "text" VARCHAR(500) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_reply_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "chat_reply_templates_userId_shortcut_key"
  ON "chat_reply_templates"("userId", "shortcut");
CREATE INDEX "chat_reply_templates_userId_idx"
  ON "chat_reply_templates"("userId");
ALTER TABLE "chat_reply_templates" ADD CONSTRAINT "chat_reply_templates_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
