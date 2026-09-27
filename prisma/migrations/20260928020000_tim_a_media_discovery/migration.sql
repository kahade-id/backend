-- Batch 19 TIM A: media & discovery untuk etalase (additive-only).
-- Hanya kolom/tabel/enum/index BARU; tidak mengubah atau menghapus yang sudah ada.
-- Bukan bagian financial core.
--
-- 1. UserShowcase.condition (enum ShowcaseCondition: BARU/BEKAS) + saveCount.
-- 2. ShowcaseImage: kind/thumbnailUrl/durationSec/width/height/groupKey/groupOrder
--    untuk media 'video' dan 'spin360' (default kind='image' agar baris lama aman).
-- 3. Tabel showcase_saves (save/bookmark etalase).
-- 4. Tabel user_highlights + user_highlight_items (highlight etalase).

-- 1. Enum kondisi barang
CREATE TYPE "ShowcaseCondition" AS ENUM ('BARU', 'BEKAS');

-- 1. Kolom baru di user_showcases
ALTER TABLE "user_showcases" ADD COLUMN "condition" "ShowcaseCondition";
ALTER TABLE "user_showcases" ADD COLUMN "saveCount" INTEGER NOT NULL DEFAULT 0;

-- 2. Kolom media baru di showcase_images
ALTER TABLE "showcase_images" ADD COLUMN "kind" VARCHAR(16) NOT NULL DEFAULT 'image';
ALTER TABLE "showcase_images" ADD COLUMN "thumbnailUrl" VARCHAR(512);
ALTER TABLE "showcase_images" ADD COLUMN "durationSec" INTEGER;
ALTER TABLE "showcase_images" ADD COLUMN "width" INTEGER;
ALTER TABLE "showcase_images" ADD COLUMN "height" INTEGER;
ALTER TABLE "showcase_images" ADD COLUMN "groupKey" VARCHAR(64);
ALTER TABLE "showcase_images" ADD COLUMN "groupOrder" INTEGER;

-- 3. Tabel save etalase
CREATE TABLE "showcase_saves" (
  "id" TEXT NOT NULL,
  "showcaseId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "showcase_saves_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "showcase_saves_userId_showcaseId_key"
  ON "showcase_saves"("userId", "showcaseId");
CREATE INDEX "showcase_saves_showcaseId_createdAt_id_idx"
  ON "showcase_saves"("showcaseId", "createdAt", "id");
CREATE INDEX "showcase_saves_userId_idx"
  ON "showcase_saves"("userId");
ALTER TABLE "showcase_saves" ADD CONSTRAINT "showcase_saves_showcaseId_fkey"
  FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "showcase_saves" ADD CONSTRAINT "showcase_saves_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Tabel highlight etalase
CREATE TABLE "user_highlights" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" VARCHAR(80) NOT NULL,
  "coverMediaId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "user_highlights_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_highlights_userId_sortOrder_idx"
  ON "user_highlights"("userId", "sortOrder");
ALTER TABLE "user_highlights" ADD CONSTRAINT "user_highlights_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "user_highlight_items" (
  "id" TEXT NOT NULL,
  "highlightId" TEXT NOT NULL,
  "showcaseId" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_highlight_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_highlight_items_highlightId_showcaseId_key"
  ON "user_highlight_items"("highlightId", "showcaseId");
CREATE INDEX "user_highlight_items_highlightId_sortOrder_idx"
  ON "user_highlight_items"("highlightId", "sortOrder");
ALTER TABLE "user_highlight_items" ADD CONSTRAINT "user_highlight_items_highlightId_fkey"
  FOREIGN KEY ("highlightId") REFERENCES "user_highlights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_highlight_items" ADD CONSTRAINT "user_highlight_items_showcaseId_fkey"
  FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
