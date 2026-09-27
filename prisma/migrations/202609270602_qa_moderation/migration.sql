-- ============================================================================
-- GAP-F (GRUP F · worker B): Moderasi platform Q&A profil — G426–G450
-- Nama migrasi: 202609270602_qa_moderation
-- APPEND-ONLY: hanya CREATE TYPE / CREATE TABLE / ALTER TABLE ADD COLUMN.
-- Tidak ada DROP/ALTER kolom existing. Idempoten bila dijalankan ulang
-- (guard DO-block per objek).
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE qa_moderation_reason AS ENUM ('SPAM','PROFANITY','HARASSMENT','PII_LEAK','SCAM_SUSPECTED','OFF_TOPIC','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qa_hidden_by_type AS ENUM ('OWNER','MODERATOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qa_report_target AS ENUM ('QUESTION','COMMENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qa_report_status AS ENUM ('PENDING','UNDER_REVIEW','DISMISSED','ACTION_TAKEN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qa_appeal_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qa_event_action AS ENUM ('HIDDEN','UNHIDDEN','REDACTED','DELETED','APPEAL_SUBMITTED','APPEAL_APPROVED','APPEAL_REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE qa_delete_approval_status AS ENUM ('PENDING','APPROVED','REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- qa_reports — antrean laporan terpisah dari showcase_reports (G431)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_reports (
  id                TEXT NOT NULL PRIMARY KEY,
  target_type       qa_report_target NOT NULL,
  target_id         TEXT NOT NULL,
  reporter_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_code       qa_moderation_reason NOT NULL,
  note              VARCHAR(500),
  status            qa_report_status NOT NULL DEFAULT 'PENDING',
  assigned_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ(3),
  resolved_by       TEXT,
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS qa_reports_target_idx   ON qa_reports (target_type, target_id);
CREATE INDEX IF NOT EXISTS qa_reports_status_idx   ON qa_reports (status, created_at);
CREATE INDEX IF NOT EXISTS qa_reports_reporter_idx ON qa_reports (reporter_id, created_at);
CREATE INDEX IF NOT EXISTS qa_reports_assignee_idx ON qa_reports (assigned_admin_id);
-- Satu laporan TERBUKA per (pelapor, target): cegah duplikat laporan.
CREATE UNIQUE INDEX IF NOT EXISTS qa_reports_open_reporter_uidx
  ON qa_reports (reporter_id, target_type, target_id)
  WHERE status IN ('PENDING', 'UNDER_REVIEW');

-- ----------------------------------------------------------------------------
-- qa_appeals — keberatan atas hide moderator (G436)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_appeals (
  id                TEXT NOT NULL PRIMARY KEY,
  target_type       qa_report_target NOT NULL,
  target_id         TEXT NOT NULL,
  appellant_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason            VARCHAR(1000) NOT NULL,
  status            qa_appeal_status NOT NULL DEFAULT 'PENDING',
  reviewer_admin_id TEXT,
  reviewed_at       TIMESTAMPTZ(3),
  review_note       VARCHAR(1000),
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS qa_appeals_target_idx    ON qa_appeals (target_type, target_id);
CREATE INDEX IF NOT EXISTS qa_appeals_status_idx    ON qa_appeals (status, created_at);
CREATE INDEX IF NOT EXISTS qa_appeals_appellant_idx ON qa_appeals (appellant_id);

-- ----------------------------------------------------------------------------
-- qa_moderation_events — audit append-only (G437); tanpa UPDATE/DELETE
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_moderation_events (
  id             TEXT NOT NULL PRIMARY KEY,
  target_type    qa_report_target NOT NULL,
  target_id      TEXT NOT NULL,
  -- Nullable: APPEAL_SUBMITTED dicatat atas nama appellant (user), bukan admin.
  actor_admin_id TEXT REFERENCES admin_users(id) ON DELETE RESTRICT,
  action         qa_event_action NOT NULL,
  reason_code    qa_moderation_reason,
  note           TEXT,
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS qa_moderation_events_target_idx ON qa_moderation_events (target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS qa_moderation_events_actor_idx  ON qa_moderation_events (actor_admin_id, created_at);
CREATE INDEX IF NOT EXISTS qa_moderation_events_action_idx ON qa_moderation_events (action, created_at);

-- ----------------------------------------------------------------------------
-- qa_delete_requests — hapus permanen dua langkah (G435)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS qa_delete_requests (
  id                   TEXT NOT NULL PRIMARY KEY,
  target_type          qa_report_target NOT NULL,
  target_id            TEXT NOT NULL,
  requested_by_admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  approved_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
  status               qa_delete_approval_status NOT NULL DEFAULT 'PENDING',
  reason               VARCHAR(1000),
  created_at           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at           TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS qa_delete_requests_status_idx ON qa_delete_requests (status, created_at);
CREATE INDEX IF NOT EXISTS qa_delete_requests_target_idx ON qa_delete_requests (target_type, target_id);

-- Guardrail: approver ≠ requester ditegakkan di service (butuh identitas),
-- didokumentasikan di sini sebagai CHECK agar pelanggaran kasat di DB.
DO $$ BEGIN
  ALTER TABLE qa_delete_requests
    ADD CONSTRAINT qa_delete_requests_approver_differs CHECK (
      approved_by_admin_id IS NULL OR approved_by_admin_id <> requested_by_admin_id
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- Kolom aditif di tabel existing (G428/G429/G434/G446)
-- ----------------------------------------------------------------------------
ALTER TABLE profile_questions ADD COLUMN IF NOT EXISTS hidden_by_type   qa_hidden_by_type;
ALTER TABLE profile_questions ADD COLUMN IF NOT EXISTS hidden_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE profile_questions ADD COLUMN IF NOT EXISTS redacted_text    VARCHAR(500);
ALTER TABLE profile_questions ADD COLUMN IF NOT EXISTS moderator_note   TEXT;
ALTER TABLE profile_questions ADD COLUMN IF NOT EXISTS assigned_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profile_questions_mod_hidden_idx ON profile_questions (hidden_by_type, "isHidden");

ALTER TABLE profile_question_comments ADD COLUMN IF NOT EXISTS hidden_by_type   qa_hidden_by_type;
ALTER TABLE profile_question_comments ADD COLUMN IF NOT EXISTS hidden_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL;
ALTER TABLE profile_question_comments ADD COLUMN IF NOT EXISTS redacted_text    VARCHAR(1000);
ALTER TABLE profile_question_comments ADD COLUMN IF NOT EXISTS moderator_note   TEXT;
ALTER TABLE profile_question_comments ADD COLUMN IF NOT EXISTS assigned_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS profile_question_comments_mod_hidden_idx ON profile_question_comments (hidden_by_type, "isHidden");

-- ----------------------------------------------------------------------------
-- G437 — qa_moderation_events bersifat append-only: cegah UPDATE/DELETE di DB.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION qa_moderation_events_no_update_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'qa_moderation_events is append-only (G437): % not allowed', TG_OP;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS qa_moderation_events_append_only ON qa_moderation_events;
CREATE TRIGGER qa_moderation_events_append_only
  BEFORE UPDATE OR DELETE ON qa_moderation_events
  FOR EACH ROW EXECUTE FUNCTION qa_moderation_events_no_update_delete();
