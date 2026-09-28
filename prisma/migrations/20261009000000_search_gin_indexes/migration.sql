-- BD-005 (perf-fix): GIN index untuk full-text search.
-- Ekspresi HARUS identik dengan yang dipakai di search.service.ts — Postgres
-- hanya memakai expression index bila ekspresinya sama persis.

-- users: dipakai di autocomplete + searchUsers
-- (coalesce(username, '') || ' ' || "fullName")
CREATE INDEX IF NOT EXISTS idx_users_fts_search
  ON users USING gin (to_tsvector('simple', coalesce(username, '') || ' ' || "fullName"));

-- user_showcases: dipakai di autocomplete (title) + searchShowcase (title+description)
CREATE INDEX IF NOT EXISTS idx_showcases_fts_title
  ON user_showcases USING gin (to_tsvector('simple', COALESCE(title, '')));
CREATE INDEX IF NOT EXISTS idx_showcases_fts_title_desc
  ON user_showcases USING gin (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(description, '')));

-- orders: dipakai di autocomplete order (title, scoped ke buyer/seller)
CREATE INDEX IF NOT EXISTS idx_orders_fts_title
  ON orders USING gin (to_tsvector('simple', COALESCE(title, '')));
