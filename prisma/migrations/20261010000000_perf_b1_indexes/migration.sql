-- Perf B1-002 / B1-008 / B1-011 (audit backend-perf 2026-09-29).
--
-- B1-002: inbox chat (getRooms) memfilter initiatorId/counterpartId TANPA filter
--   type + ORDER BY updatedAt. Index komposit lama diawali kolom `type` sehingga
--   tidak terpakai saat typeFilter NULL (kasus default) -> seq scan + sort.
--   Index baru melayani predicate + sort dalam satu index.
--
-- B1-008: RENCANA drop index redundan DITUNDA (keputusan integrasi 2026-09-29):
--   perubahan DB finansial-core bersifat additive-only, dan klaim redundansi
--   "left-prefix btree" TIDAK berlaku untuk [userId, createdAt] terhadap
--   [userId, isRead, createdAt] — butuh bukti pola query produksi +
--   persetujuan maintenance sebelum drop. TIDAK ADA DROP INDEX di migrasi ini.
--
-- B1-011: sinyal feed "Untuk Anda" sort 200 like terakhir per user
--   (ORDER BY createdAt DESC, id DESC) tanpa index komposit.

-- B1-002
CREATE INDEX "chat_rooms_initiatorId_updatedAt_idx" ON "chat_rooms"("initiatorId", "updatedAt");
CREATE INDEX "chat_rooms_counterpartId_updatedAt_idx" ON "chat_rooms"("counterpartId", "updatedAt");

-- B1-008 (ditunda — lihat komentar header; tidak ada DROP di sini)

-- B1-011
CREATE INDEX "showcase_likes_userId_createdAt_id_idx" ON "showcase_likes"("userId", "createdAt", "id");
