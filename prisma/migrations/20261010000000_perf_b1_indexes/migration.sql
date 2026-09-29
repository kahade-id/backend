-- Perf B1-002 / B1-008 / B1-011 (audit backend-perf 2026-09-29).
--
-- B1-002: inbox chat (getRooms) memfilter initiatorId/counterpartId TANPA filter
--   type + ORDER BY updatedAt. Index komposit lama diawali kolom `type` sehingga
--   tidak terpakai saat typeFilter NULL (kasus default) -> seq scan + sort.
--   Index baru melayani predicate + sort dalam satu index.
--
-- B1-008: drop 3 index REDUNDAN di tabel hot (write amplification tiap INSERT):
--   - notifications: [userId, isRead] redundan thd [userId, isRead, createdAt]
--     (left-prefix btree). [userId, createdAt] BUKAN prefix persis, tetapi
--     di-drop sesuai arahan audit: query list notifikasi selalu ber-predicate
--     userId dan umumnya ber-filter isRead; untuk list TANPA filter isRead,
--     planner tetap memakai [userId, isRead, createdAt] lewat dua range scan
--     (isRead true/false) + merge — masih index-backed, biaya minor.
--   - chat_messages: [roomId] redundan thd [roomId, createdAt]
--   - webhook_logs: [source, isProcessed] redundan thd [source, isProcessed, nextRetryAt]
--   Drop index TIDAK menghapus data (aman, tanpa data loss), tapi butuh jendela
--   deploy karena DROP INDEX memegang lock singkat. Tabel masih kecil sehingga
--   lock dapat diabaikan; tanpa CONCURRENTLY karena migrasi Prisma jalan di
--   dalam transaksi.
--
-- B1-011: sinyal feed "Untuk Anda" sort 200 like terakhir per user
--   (ORDER BY createdAt DESC, id DESC) tanpa index komposit.

-- B1-002
CREATE INDEX "chat_rooms_initiatorId_updatedAt_idx" ON "chat_rooms"("initiatorId", "updatedAt");
CREATE INDEX "chat_rooms_counterpartId_updatedAt_idx" ON "chat_rooms"("counterpartId", "updatedAt");

-- B1-008
DROP INDEX IF EXISTS "notifications_userId_isRead_idx";
DROP INDEX IF EXISTS "notifications_userId_createdAt_idx";
DROP INDEX IF EXISTS "chat_messages_roomId_idx";
DROP INDEX IF EXISTS "webhook_logs_source_isProcessed_idx";

-- B1-011
CREATE INDEX "showcase_likes_userId_createdAt_id_idx" ON "showcase_likes"("userId", "createdAt", "id");
