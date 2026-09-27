-- Populer harian + agregat view harian etalase (additive-only: hanya kolom /
-- tabel / index baru, tidak mengubah atau menghapus yang sudah ada).
-- Bukan bagian financial core.

-- Kolom denormalisasi untuk ranking sort "popular" (populer harian):
-- hotViews = view pada hari kalender berjalan (Asia/Jakarta),
-- hotViewDate = tanggal bucket-nya. Di-reset otomatis oleh aplikasi
-- (CASE atomik di recordView) — tanpa cron.
ALTER TABLE "user_showcases" ADD COLUMN "hotViews" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_showcases" ADD COLUMN "hotViewDate" DATE;
CREATE INDEX "user_showcases_visibility_isActive_hotViews_id_idx"
  ON "user_showcases"("visibility", "isActive", "hotViews", "id");

-- Riwayat agregat harian (satu baris per showcase per hari). Ditulis
-- best-effort oleh recordView; dipakai analitik/admin.
CREATE TABLE "showcase_daily_stats" (
  "id" TEXT NOT NULL,
  "showcaseId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "showcase_daily_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "showcase_daily_stats_showcaseId_date_key"
  ON "showcase_daily_stats"("showcaseId", "date");
CREATE INDEX "showcase_daily_stats_date_idx"
  ON "showcase_daily_stats"("date");
ALTER TABLE "showcase_daily_stats"
  ADD CONSTRAINT "showcase_daily_stats_showcaseId_fkey"
  FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
