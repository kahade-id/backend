-- BD-004 (perf-fix): denormalisasi unread counter per member room chat.
--
-- Menggantikan full-scan `COUNT(*) ... WHERE NOT jsonb_exists("readAt", userId)`
-- per baris di daftar chat (LATERAL subquery) dengan kolom counter yang
-- di-maintain saat kirim/baca pesan.
--
-- Additive-only: hanya ADD COLUMN + backfill nilai awal. Tidak mengubah
-- kolom/tabel/data lain.

ALTER TABLE "chat_room_members" ADD COLUMN "unreadCount" INTEGER NOT NULL DEFAULT 0;

-- Backfill: hitung unread awal dengan logika yang SAMA dengan query lama
-- (pesan bukan dari user tsb DAN belum ditandai dibaca olehnya).
UPDATE "chat_room_members" cm
SET "unreadCount" = sub.cnt
FROM (
  SELECT cm2."roomId", cm2."userId", COUNT(*)::int AS cnt
  FROM "chat_room_members" cm2
  JOIN "chat_messages" m ON m."roomId" = cm2."roomId"
  WHERE m."isDeleted" = false
    AND (m."senderId" IS NULL OR m."senderId" != cm2."userId")
    AND (m."readAt" IS NULL OR NOT jsonb_exists(m."readAt", cm2."userId"))
  GROUP BY cm2."roomId", cm2."userId"
) sub
WHERE cm."roomId" = sub."roomId" AND cm."userId" = sub."userId";
