-- Migration: GIN full-text indexes + price btree for Discovery (search & feed).
--
-- T5/S4 (audit Discovery 2026-09-26): kode search sudah memakai
-- to_tsvector('simple', ...) di $queryRaw (suggestions & unified search) dan
-- filter rentang harga di feed etalase — tetapi index GIN hanya ada untuk
-- tabel users. Tanpa index ini, pencarian etalase/pesanan/FAQ = sequential
-- scan, dan filter harga = scan pada kolom BigInt nullable.
--
-- Ekspresi index HARUS identik dengan yang dipakai query aplikasi
-- (lihat src/modules/search/search.service.ts) agar planner memilih index.
--
-- NOTE: CREATE INDEX CONCURRENTLY sengaja TIDAK dipakai karena Prisma
-- menjalankan migration dalam transaksi implisit (lihat migration
-- 20260318_gin_search). Jalankan pada window trafik rendah di production.

-- FTS etalase: dipakai searchShowcase (title + description).
CREATE INDEX IF NOT EXISTS idx_user_showcases_fts_search
  ON user_showcases USING GIN (
    to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,''))
  );

-- FTS pesanan milik pengguna: dipakai searchOrders (title + description).
CREATE INDEX IF NOT EXISTS idx_orders_fts_search
  ON orders USING GIN (
    to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,''))
  );

-- FTS FAQ: dipakai searchFaq (question + answer).
CREATE INDEX IF NOT EXISTS idx_faq_items_fts_search
  ON faq_items USING GIN (
    to_tsvector('simple', COALESCE(question,'') || ' ' || COALESCE(answer,''))
  );

-- Filter rentang harga feed etalase memakai klausa OR pada priceMin/priceMax
-- (nullable BigInt); dua index kolom-tunggal memungkinkan bitmapOr.
CREATE INDEX IF NOT EXISTS idx_user_showcases_price_min
  ON user_showcases ("priceMin")
  WHERE "deletedAt" IS NULL AND "isActive" = true AND "isPublic" = true;

CREATE INDEX IF NOT EXISTS idx_user_showcases_price_max
  ON user_showcases ("priceMax")
  WHERE "deletedAt" IS NULL AND "isActive" = true AND "isPublic" = true;
