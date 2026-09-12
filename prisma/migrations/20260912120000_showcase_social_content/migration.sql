-- ============================================================
-- Section 3: Showcase -> konten sosial + feed discover
-- ============================================================
-- Mengubah `user_showcases` dari etalase statis (satu kolom imageUrl) menjadi
-- konten sosial:
--   * banyak gambar      -> tabel baru showcase_images (sortOrder)
--   * filter kategori    -> kolom category
--   * visibilitas        -> kolom visibility (PUBLIC/PRIVATE, default PUBLIC)
--   * like / komentar    -> tabel showcase_likes + showcase_comments
--   * counter denorm.    -> likeCount / commentCount / viewCount
--
-- Mengikuti prisma/MIGRATION_SAFETY.md:
--   rule 3 -> semua kolom baru nullable ATAU ber-default (kode lama tetap jalan)
--   rule 2 -> rename via copy: imageUrl DI-BACKFILL dulu ke showcase_images di
--             migration ini; kolom lamanya baru di-drop di migration TERPISAH
--             (20260912130000_drop_legacy_showcase_image_url).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Enum
-- ------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "ShowcaseVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ContentHiddenReason" AS ENUM ('SPAM', 'INAPPROPRIATE', 'HARASSMENT', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 2. Kolom baru di user_showcases
-- ------------------------------------------------------------
ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "category" VARCHAR(60);

-- Default PUBLIC: item lama otomatis tetap tampil di feed discover, sama seperti
-- perilaku sebelumnya (tidak ada perubahan visibilitas yang diam-diam).
ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "visibility" "ShowcaseVisibility" NOT NULL DEFAULT 'PUBLIC';

-- Counter denormalisasi. Diisi 0 lalu di-backfill dari data aktual di langkah 6
-- supaya feed "popular" langsung punya urutan yang benar, bukan urutan acak.
ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "likeCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "commentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_showcases" ADD COLUMN IF NOT EXISTS "viewCount" INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- 3. Tabel showcase_images
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "showcase_images" (
  "id"         TEXT NOT NULL,
  "showcaseId" TEXT NOT NULL,
  "imageUrl"   VARCHAR(512) NOT NULL,
  "fileKey"    VARCHAR(512),
  "sortOrder"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "showcase_images_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "showcase_images_showcaseId_sortOrder_idx"
  ON "showcase_images"("showcaseId", "sortOrder");

DO $$ BEGIN
  ALTER TABLE "showcase_images"
    ADD CONSTRAINT "showcase_images_showcaseId_fkey"
    FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 4. Tabel showcase_likes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "showcase_likes" (
  "id"         TEXT NOT NULL,
  "showcaseId" TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "showcase_likes_pkey" PRIMARY KEY ("id")
);

-- Unique (userId, showcaseId): like ganda mustahil walau dua request balapan.
CREATE UNIQUE INDEX IF NOT EXISTS "showcase_likes_userId_showcaseId_key"
  ON "showcase_likes"("userId", "showcaseId");
CREATE INDEX IF NOT EXISTS "showcase_likes_showcaseId_createdAt_id_idx"
  ON "showcase_likes"("showcaseId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "showcase_likes_userId_idx"
  ON "showcase_likes"("userId");

DO $$ BEGIN
  ALTER TABLE "showcase_likes"
    ADD CONSTRAINT "showcase_likes_showcaseId_fkey"
    FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "showcase_likes"
    ADD CONSTRAINT "showcase_likes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 5. Tabel showcase_comments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "showcase_comments" (
  "id"           TEXT NOT NULL,
  "showcaseId"   TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "parentId"     TEXT,
  "content"      TEXT NOT NULL,
  "isHidden"     BOOLEAN NOT NULL DEFAULT false,
  "hiddenReason" "ContentHiddenReason",
  "hiddenAt"     TIMESTAMP(3),
  "hiddenBy"     VARCHAR(100),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "showcase_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "showcase_comments_showcaseId_parentId_createdAt_id_idx"
  ON "showcase_comments"("showcaseId", "parentId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "showcase_comments_userId_idx"
  ON "showcase_comments"("userId");

DO $$ BEGIN
  ALTER TABLE "showcase_comments"
    ADD CONSTRAINT "showcase_comments_showcaseId_fkey"
    FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "showcase_comments"
    ADD CONSTRAINT "showcase_comments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Self-relation untuk balasan bersarang. CASCADE: menghapus induk ikut
-- menghapus balasannya (satu tingkat saja, jadi tidak ada rantai panjang).
DO $$ BEGIN
  ALTER TABLE "showcase_comments"
    ADD CONSTRAINT "showcase_comments_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "showcase_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Invariant moderasi: hiddenReason/hiddenAt hanya relevan bila isHidden true.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'showcase_comment_hidden_fields_consistent'
  ) THEN
    ALTER TABLE "showcase_comments" ADD CONSTRAINT showcase_comment_hidden_fields_consistent
      CHECK (
        ("isHidden" = false AND "hiddenReason" IS NULL AND "hiddenAt" IS NULL)
        OR ("isHidden" = true AND "hiddenReason" IS NOT NULL)
      );
    RAISE NOTICE 'Added: showcase_comment_hidden_fields_consistent';
  ELSE
    RAISE NOTICE 'Exists: showcase_comment_hidden_fields_consistent';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 6. Backfill
-- ------------------------------------------------------------
-- 6a. Salin imageUrl lama menjadi satu baris showcase_images (sortOrder 0).
-- Baris dengan imageUrl NULL/string kosong dilewati. `fileKey` dibiarkan NULL
-- karena URL lama bisa menunjuk objek di luar folder uploads/showcase-images/
-- yang tidak bisa kita hapus dengan aman.
INSERT INTO "showcase_images" ("id", "showcaseId", "imageUrl", "fileKey", "sortOrder", "createdAt", "updatedAt")
SELECT
  'img_' || s."id",
  s."id",
  s."imageUrl",
  NULL,
  0,
  s."createdAt",
  CURRENT_TIMESTAMP
FROM "user_showcases" s
WHERE s."imageUrl" IS NOT NULL
  AND btrim(s."imageUrl") <> ''
  -- Idempotent: migration yang diulang tidak boleh menduplikasi gambar.
  AND NOT EXISTS (SELECT 1 FROM "showcase_images" i WHERE i."showcaseId" = s."id")
ON CONFLICT ("id") DO NOTHING;

-- 6b. Counter dari data aktual (0 untuk tabel baru, tapi ditulis eksplisit agar
-- migration ini aman dijalankan ulang setelah tabel terisi).
UPDATE "user_showcases" s
SET "likeCount" = COALESCE(l.cnt, 0)
FROM (SELECT "showcaseId", COUNT(*)::int AS cnt FROM "showcase_likes" GROUP BY "showcaseId") l
WHERE s."id" = l."showcaseId" AND s."likeCount" <> COALESCE(l.cnt, 0);

UPDATE "user_showcases" s
SET "commentCount" = COALESCE(c.cnt, 0)
FROM (
  SELECT "showcaseId", COUNT(*)::int AS cnt
  FROM "showcase_comments"
  WHERE "isHidden" = false
  GROUP BY "showcaseId"
) c
WHERE s."id" = c."showcaseId" AND s."commentCount" <> COALESCE(c.cnt, 0);

-- ------------------------------------------------------------
-- 7. Index feed discover
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "user_showcases_visibility_isActive_createdAt_id_idx"
  ON "user_showcases"("visibility", "isActive", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "user_showcases_visibility_isActive_likeCount_id_idx"
  ON "user_showcases"("visibility", "isActive", "likeCount", "id");
CREATE INDEX IF NOT EXISTS "user_showcases_category_idx"
  ON "user_showcases"("category");
