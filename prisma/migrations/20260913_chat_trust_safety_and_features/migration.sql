-- ============================================================
-- Chat: Trust & Safety + fitur chat yang "dijanjikan" README
-- ============================================================
-- Latar belakang (audit internal):
--   1. Tidak ada deteksi circumvention di chat. Buyer/seller bisa tukar nomor
--      HP atau link WA/Telegram lalu transaksi di luar Kahade. Begitu dana
--      keluar dari escrow, proteksi hilang dan tiket dispute tidak bisa
--      ditindaklanjuti. Ini risiko bisnis nomor satu di surface chat.
--   2. `deleteMessage()` tidak memeriksa status order: pesan bisa dihapus saat
--      order DISPUTED, dan `content` di-null-kan permanen sehingga bukti
--      percakapan hilang untuk resolver dispute.
--   3. README menyebut chat punya "reactions", tapi tidak ada model/endpoint.
--      `isEdited` dan `ChatRoom.isArchived` adalah kolom mati: tidak pernah
--      ditulis oleh kode mana pun.
--   4. Chat hanya bisa ada setelah order dibuat (orderId NOT NULL), sehingga
--      tidak ada nego pra-transaksi.
--
-- Migration ini menambah fondasi DB untuk semua itu:
--   * enum: ChatRoomType, ChatRoomStatus, ChatRoomMemberRole,
--           ChatModerationKind/Severity/Action/Status + ChatMessageType.VOICE
--   * chat_rooms.orderId  -> NULLABLE (untuk room INQUIRY pra-transaksi)
--   * chat_rooms          -> type, status, initiatorId, counterpartId, subject
--   * chat_messages       -> editedAt, deletedContent, deletedById,
--                            durationSeconds, isPinned*, forwardedFromId,
--                            kolom ringkasan moderasi
--   * tabel baru: chat_message_reactions, chat_message_edits,
--                 chat_room_members, chat_moderation_events
--   * index trigram untuk search dalam chat
--
-- Semua kolom baru nullable atau ber-default (prisma/MIGRATION_SAFETY.md
-- rule 3), tidak ada DROP, tidak ada rename, tidak ada perubahan tipe — kode
-- lama tetap berjalan normal sebelum deploy baru selesai.
-- ============================================================

-- ------------------------------------------------------------
-- 0. Enum baru
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ChatRoomType" AS ENUM ('ORDER', 'INQUIRY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChatRoomStatus" AS ENUM ('ACTIVE', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChatRoomMemberRole" AS ENUM ('BUYER', 'SELLER', 'INITIATOR', 'COUNTERPART');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChatModerationKind" AS ENUM ('CIRCUMVENTION', 'CONTACT_SHARING', 'PROFANITY', 'SPAM');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChatModerationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChatModerationAction" AS ENUM ('BLOCKED', 'REDACTED', 'FLAGGED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChatModerationStatus" AS ENUM ('PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 1. ChatMessageType: VOICE (voice note)
-- ------------------------------------------------------------
-- `ADD VALUE` tidak bisa dijalankan di dalam transaction block pada PostgreSQL
-- < 12. Repo ini sudah memakai sintaks yang sama di migration
-- 20260912140000, sehingga target minimum diasumsikan PostgreSQL 12+.
ALTER TYPE "ChatMessageType" ADD VALUE IF NOT EXISTS 'VOICE';

-- ------------------------------------------------------------
-- 2. chat_rooms: orderId nullable + kolom peserta/type/status
-- ------------------------------------------------------------
-- DROP NOT NULL diperlukan agar room INQUIRY (pra-transaksi) bisa ada tanpa
-- order. Ini bukan penghapusan data: baris ORDER room yang sudah ada tetap
-- punya orderId, dan aplikasi menjaga invariant lewat CHECK constraint di
-- bagian 2d.
ALTER TABLE "chat_rooms" ALTER COLUMN "orderId" DROP NOT NULL;

ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "type" "ChatRoomType" NOT NULL DEFAULT 'ORDER';
ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "status" "ChatRoomStatus" NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "initiatorId" TEXT;
ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "counterpartId" TEXT;
ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "subject" VARCHAR(200);

-- 2a. Backfill peserta untuk room yang sudah ada dari order-nya.
--     Pasangan peserta menjadi sumber kebenaran authorization supaya room
--     tanpa order tetap bisa diotorisasi dengan jalur kode yang sama.
UPDATE "chat_rooms" cr
SET "initiatorId"   = o."buyerId",
    "counterpartId" = o."sellerId"
FROM "orders" o
WHERE o.id = cr."orderId"
  AND (cr."initiatorId" IS NULL OR cr."counterpartId" IS NULL);

-- 2b. Foreign key peserta.
DO $$ BEGIN
  ALTER TABLE "chat_rooms"
    ADD CONSTRAINT "chat_rooms_initiatorId_fkey"
    FOREIGN KEY ("initiatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_rooms"
    ADD CONSTRAINT "chat_rooms_counterpartId_fkey"
    FOREIGN KEY ("counterpartId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2c. Index daftar room per peserta.
CREATE INDEX IF NOT EXISTS "chat_rooms_type_initiatorId_idx"
  ON "chat_rooms"("type", "initiatorId");
CREATE INDEX IF NOT EXISTS "chat_rooms_type_counterpartId_idx"
  ON "chat_rooms"("type", "counterpartId");
CREATE INDEX IF NOT EXISTS "chat_rooms_type_status_idx"
  ON "chat_rooms"("type", "status");

-- 2d. Invariant: ORDER room wajib punya order, INQUIRY room wajib punya dua
--     peserta. Divalidasi saat ADD CONSTRAINT, jadi backfill 2a harus jalan
--     lebih dulu.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chat_rooms_participants_consistent'
  ) THEN
    ALTER TABLE "chat_rooms" ADD CONSTRAINT chat_rooms_participants_consistent
      CHECK (
        ("type" = 'ORDER'   AND "orderId" IS NOT NULL)
        OR
        ("type" = 'INQUIRY' AND "initiatorId" IS NOT NULL AND "counterpartId" IS NOT NULL)
      );
    RAISE NOTICE 'Added: chat_rooms_participants_consistent';
  ELSE
    RAISE NOTICE 'Exists: chat_rooms_participants_consistent';
  END IF;
END $$;

-- 2e. Satu room INQUIRY aktif per pasangan user.
--     Pairing disimpan dalam urutan kanonik (initiatorId < counterpartId) oleh
--     aplikasi — LEAST()/GREATEST() tidak bisa dipakai di index expression
--     karena keduanya hanya STABLE, bukan IMMUTABLE.
CREATE UNIQUE INDEX IF NOT EXISTS "chat_rooms_inquiry_pair_key"
  ON "chat_rooms"("initiatorId", "counterpartId")
  WHERE "type" = 'INQUIRY' AND "deletedAt" IS NULL;

-- ------------------------------------------------------------
-- 3. chat_messages: metadata edit/hapus/pin/forward/moderasi
-- ------------------------------------------------------------
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "editedAt" TIMESTAMP(3);
-- Isi asli yang dipertahankan saat pesan dihapus. Tanpa ini, "hapus pesan" sama
-- dengan "musnahkan bukti", yang tidak bisa diterima saat order DISPUTED.
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "deletedContent" TEXT;
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "deletedById" TEXT;
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER;
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "isPinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "pinnedAt" TIMESTAMP(3);
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "pinnedById" TEXT;
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "forwardedFromId" TEXT;
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "moderationAction" "ChatModerationAction";
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "moderationSeverity" "ChatModerationSeverity";
ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "moderationKind" "ChatModerationKind";

DO $$ BEGIN
  ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_pinnedById_fkey"
    FOREIGN KEY ("pinnedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_forwardedFromId_fkey"
    FOREIGN KEY ("forwardedFromId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "chat_messages_roomId_isPinned_idx"
  ON "chat_messages"("roomId", "isPinned");
-- Dipakai admin/dispute resolver untuk membaca pesan terhapus (soft delete
-- otomatis tersembunyi dari kueri Prisma biasa lewat middleware deletedAt).
CREATE INDEX IF NOT EXISTS "chat_messages_isDeleted_idx"
  ON "chat_messages"("isDeleted");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chat_message_pinned_fields_consistent'
  ) THEN
    ALTER TABLE "chat_messages" ADD CONSTRAINT chat_message_pinned_fields_consistent
      CHECK (
        ("isPinned" = false AND "pinnedAt" IS NULL AND "pinnedById" IS NULL)
        OR
        ("isPinned" = true AND "pinnedAt" IS NOT NULL)
      );
    RAISE NOTICE 'Added: chat_message_pinned_fields_consistent';
  ELSE
    RAISE NOTICE 'Exists: chat_message_pinned_fields_consistent';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chat_message_edited_fields_consistent'
  ) THEN
    ALTER TABLE "chat_messages" ADD CONSTRAINT chat_message_edited_fields_consistent
      CHECK ("editedAt" IS NULL OR "isEdited" = true);
    RAISE NOTICE 'Added: chat_message_edited_fields_consistent';
  ELSE
    RAISE NOTICE 'Exists: chat_message_edited_fields_consistent';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'chat_message_duration_seconds_valid'
  ) THEN
    ALTER TABLE "chat_messages" ADD CONSTRAINT chat_message_duration_seconds_valid
      CHECK ("durationSeconds" IS NULL OR ("durationSeconds" > 0 AND "durationSeconds" <= 600));
    RAISE NOTICE 'Added: chat_message_duration_seconds_valid';
  ELSE
    RAISE NOTICE 'Exists: chat_message_duration_seconds_valid';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. chat_message_reactions (fitur "reactions" yang dijanjikan README)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "chat_message_reactions" (
  "id"        TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "emoji"     VARCHAR(16) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_message_reactions_pkey" PRIMARY KEY ("id")
);

-- Satu emoji per (pesan, user). User boleh memberi beberapa emoji BERBEDA pada
-- pesan yang sama (model Slack), bukan satu reaksi saja (model WhatsApp).
CREATE UNIQUE INDEX IF NOT EXISTS "chat_message_reactions_messageId_userId_emoji_key"
  ON "chat_message_reactions"("messageId", "userId", "emoji");
CREATE INDEX IF NOT EXISTS "chat_message_reactions_messageId_idx"
  ON "chat_message_reactions"("messageId");
CREATE INDEX IF NOT EXISTS "chat_message_reactions_userId_idx"
  ON "chat_message_reactions"("userId");

DO $$ BEGIN
  ALTER TABLE "chat_message_reactions"
    ADD CONSTRAINT "chat_message_reactions_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_message_reactions"
    ADD CONSTRAINT "chat_message_reactions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 5. chat_message_edits (riwayat revisi pesan)
-- ------------------------------------------------------------
-- Tanpa riwayat ini, edit pesan = menghapus bukti secara diam-diam. Resolver
-- dispute harus bisa melihat apa yang tertulis sebelum diedit.
CREATE TABLE IF NOT EXISTS "chat_message_edits" (
  "id"              TEXT NOT NULL,
  "messageId"       TEXT NOT NULL,
  "editorId"        TEXT NOT NULL,
  "previousContent" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_message_edits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "chat_message_edits_messageId_createdAt_idx"
  ON "chat_message_edits"("messageId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "chat_message_edits"
    ADD CONSTRAINT "chat_message_edits_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_message_edits"
    ADD CONSTRAINT "chat_message_edits_editorId_fkey"
    FOREIGN KEY ("editorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 6. chat_room_members (arsip & mute per peserta)
-- ------------------------------------------------------------
-- ChatRoom.isArchived bersifat global sehingga tidak bisa dipakai untuk
-- "saya arsipkan, lawan bicara tidak". Status per peserta ada di sini; kolom
-- lama tetap di-mirror aplikasi (true hanya bila kedua peserta mengarsipkan).
CREATE TABLE IF NOT EXISTS "chat_room_members" (
  "id"         TEXT NOT NULL,
  "roomId"     TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "role"       "ChatRoomMemberRole" NOT NULL DEFAULT 'BUYER',
  "isArchived" BOOLEAN NOT NULL DEFAULT false,
  "archivedAt" TIMESTAMP(3),
  "isMuted"    BOOLEAN NOT NULL DEFAULT false,
  "mutedUntil" TIMESTAMP(3),
  "lastReadAt" TIMESTAMP(3),
  "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_room_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_room_members_roomId_userId_key"
  ON "chat_room_members"("roomId", "userId");
CREATE INDEX IF NOT EXISTS "chat_room_members_userId_isArchived_idx"
  ON "chat_room_members"("userId", "isArchived");
CREATE INDEX IF NOT EXISTS "chat_room_members_userId_isMuted_idx"
  ON "chat_room_members"("userId", "isMuted");

DO $$ BEGIN
  ALTER TABLE "chat_room_members"
    ADD CONSTRAINT "chat_room_members_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_room_members"
    ADD CONSTRAINT "chat_room_members_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6a. Backfill membership untuk room yang sudah ada.
--     id dibentuk mirip cuid ('c' + 24 char [0-9a-f]) supaya lolos validator
--     format id yang sama dengan id buatan aplikasi.
INSERT INTO "chat_room_members" ("id", "roomId", "userId", "role", "joinedAt", "updatedAt")
SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
       cr.id, cr."initiatorId", 'BUYER', COALESCE(cr."createdAt", now()), now()
FROM "chat_rooms" cr
WHERE cr."initiatorId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "chat_room_members" m
    WHERE m."roomId" = cr.id AND m."userId" = cr."initiatorId"
  );

INSERT INTO "chat_room_members" ("id", "roomId", "userId", "role", "joinedAt", "updatedAt")
SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text), 1, 24),
       cr.id, cr."counterpartId", 'SELLER', COALESCE(cr."createdAt", now()), now()
FROM "chat_rooms" cr
WHERE cr."counterpartId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "chat_room_members" m
    WHERE m."roomId" = cr.id AND m."userId" = cr."counterpartId"
  );

-- ------------------------------------------------------------
-- 7. chat_moderation_events (jejak audit Trust & Safety + antrean moderasi)
-- ------------------------------------------------------------
-- Pesan yang DIBLOKIR tidak pernah tersimpan, sehingga event ini adalah
-- satu-satunya rekam jejaknya. Tanpa tabel ini, deteksi circumvention tidak
-- bisa dievaluasi: kita tidak akan pernah tahu berapa banyak yang dicegah atau
-- seberapa sering false positive terjadi.
CREATE TABLE IF NOT EXISTS "chat_moderation_events" (
  "id"           TEXT NOT NULL,
  "eventId"      TEXT NOT NULL,
  "roomId"       TEXT,
  "messageId"    TEXT,
  "userId"       TEXT NOT NULL,
  "kind"         "ChatModerationKind" NOT NULL,
  "severity"     "ChatModerationSeverity" NOT NULL,
  "action"       "ChatModerationAction" NOT NULL,
  "matchers"     JSONB,
  "snippet"      VARCHAR(280),
  "status"       "ChatModerationStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedById" TEXT,
  "reviewedAt"   TIMESTAMP(3),
  "reviewNote"   VARCHAR(500),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_moderation_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_moderation_events_eventId_key"
  ON "chat_moderation_events"("eventId");
-- Antrean moderasi: WHERE status = 'PENDING' ORDER BY "createdAt" DESC.
CREATE INDEX IF NOT EXISTS "chat_moderation_events_status_createdAt_idx"
  ON "chat_moderation_events"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_moderation_events_severity_createdAt_idx"
  ON "chat_moderation_events"("severity", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_moderation_events_userId_createdAt_idx"
  ON "chat_moderation_events"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "chat_moderation_events_roomId_idx"
  ON "chat_moderation_events"("roomId");
CREATE INDEX IF NOT EXISTS "chat_moderation_events_action_idx"
  ON "chat_moderation_events"("action");

DO $$ BEGIN
  ALTER TABLE "chat_moderation_events"
    ADD CONSTRAINT "chat_moderation_events_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chat_moderation_events"
    ADD CONSTRAINT "chat_moderation_events_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 8. Index pencarian teks dalam chat
-- ------------------------------------------------------------
-- Search memakai ILIKE '%kata%'. B-tree biasa tidak bisa melayani pola dengan
-- wildcard di awal, sehingga diperlukan index trigram (pg_trgm). Ekstensi
-- dibuat defensif: bila hak akses tidak cukup, search tetap jalan (lebih
-- lambat) alih-alih membuat migration gagal di production.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm tidak tersedia (%)— chat search memakai sequential scan', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS "chat_messages_content_trgm_idx"
      ON "chat_messages" USING gin ("content" gin_trgm_ops);
    RAISE NOTICE 'Added: chat_messages_content_trgm_idx';
  ELSE
    RAISE NOTICE 'Skipped: chat_messages_content_trgm_idx (pg_trgm tidak aktif)';
  END IF;
END $$;

-- ============================================================
-- ROLLBACK
-- ============================================================
-- Tidak ada yang di-drop atau di-rename, sehingga rollback aman berupa
-- penghapusan objek baru bila benar-benar diperlukan:
--
--   DROP INDEX IF EXISTS "chat_messages_content_trgm_idx";
--   DROP TABLE IF EXISTS "chat_moderation_events";
--   DROP TABLE IF EXISTS "chat_room_members";
--   DROP TABLE IF EXISTS "chat_message_edits";
--   DROP TABLE IF EXISTS "chat_message_reactions";
--   ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS chat_message_duration_seconds_valid;
--   ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS chat_message_edited_fields_consistent;
--   ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS chat_message_pinned_fields_consistent;
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "moderationKind";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "moderationSeverity";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "moderationAction";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "forwardedFromId";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "pinnedById";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "pinnedAt";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "isPinned";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "durationSeconds";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "deletedById";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "deletedContent";
--   ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "editedAt";
--   ALTER TABLE "chat_rooms" DROP CONSTRAINT IF EXISTS chat_rooms_participants_consistent;
--   DROP INDEX IF EXISTS "chat_rooms_inquiry_pair_key";
--   ALTER TABLE "chat_rooms" DROP COLUMN IF EXISTS "subject";
--   ALTER TABLE "chat_rooms" DROP COLUMN IF EXISTS "counterpartId";
--   ALTER TABLE "chat_rooms" DROP COLUMN IF EXISTS "initiatorId";
--   ALTER TABLE "chat_rooms" DROP COLUMN IF EXISTS "status";
--   ALTER TABLE "chat_rooms" DROP COLUMN IF EXISTS "type";
--   -- HATI-HATI: mengembalikan NOT NULL akan gagal bila sudah ada room INQUIRY.
--   --   ALTER TABLE "chat_rooms" ALTER COLUMN "orderId" SET NOT NULL;
--   DROP TYPE IF EXISTS "ChatModerationStatus";
--   DROP TYPE IF EXISTS "ChatModerationAction";
--   DROP TYPE IF EXISTS "ChatModerationSeverity";
--   DROP TYPE IF EXISTS "ChatModerationKind";
--   DROP TYPE IF EXISTS "ChatRoomMemberRole";
--   DROP TYPE IF EXISTS "ChatRoomStatus";
--   DROP TYPE IF EXISTS "ChatRoomType";
--   -- Nilai enum tidak bisa dihapus di PostgreSQL; ChatMessageType.VOICE
--   -- dibiarkan ada (tidak dipakai kode lama).
