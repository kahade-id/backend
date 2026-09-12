-- ============================================================
-- ROLLBACK: user_showcases.imageUrl (Section 3)
-- ============================================================
-- Dipakai bila migration 20260912130000_drop_legacy_showcase_image_url harus
-- dibatalkan. Mengembalikan kolom legacy dan mengisinya dari gambar pertama
-- (sortOrder terkecil) tiap showcase — bentuk yang setara dengan data sebelum
-- Section 3, karena sebelumnya tiap item memang hanya punya satu gambar.
--
-- Cara pakai:
--   psql "$DATABASE_URL" -f prisma/migrations/ROLLBACK_showcase_imageUrl.sql
--   npx prisma migrate resolve --rolled-back 20260912130000_drop_legacy_showcase_image_url
-- ============================================================

ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;

UPDATE "user_showcases" s
SET "imageUrl" = first_img."imageUrl"
FROM (
  SELECT DISTINCT ON ("showcaseId") "showcaseId", "imageUrl"
  FROM "showcase_images"
  ORDER BY "showcaseId", "sortOrder" ASC, "id" ASC
) first_img
WHERE s."id" = first_img."showcaseId"
  AND s."imageUrl" IS NULL;
