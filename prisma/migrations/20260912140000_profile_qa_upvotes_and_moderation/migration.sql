-- ============================================================
-- Section 4: Profile Q&A — upvote, alasan moderasi, reminder 48 jam
-- ============================================================
-- Tiga perubahan pada fitur tanya-jawab profil:
--   1. Upvote pertanyaan  -> tabel profile_question_upvotes + counter
--      denormalisasi profile_questions.upvoteCount.
--   2. `isHidden` polos digantikan alasan kategoris (ContentHiddenReason,
--      enum yang sudah dibuat migration 20260912120000_showcase_social_content)
--      pada profile_questions DAN profile_question_comments.
--   3. Pengingat 48 jam untuk pertanyaan yang belum dijawab ->
--      profile_questions.reminderSentAt (klaim sekali-kirim) +
--      NotificationType.QUESTION_UNANSWERED_REMINDER.
--
-- Semua kolom baru nullable atau ber-default (prisma/MIGRATION_SAFETY.md rule 3)
-- sehingga tidak ada perubahan destruktif dan kode lama tetap jalan.
-- ============================================================

-- ------------------------------------------------------------
-- 1. NotificationType baru
-- ------------------------------------------------------------
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'QUESTION_UNANSWERED_REMINDER';

-- ------------------------------------------------------------
-- 2. Kolom baru di profile_questions
-- ------------------------------------------------------------
ALTER TABLE "profile_questions" ADD COLUMN IF NOT EXISTS "hiddenReason" "ContentHiddenReason";
ALTER TABLE "profile_questions" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3);
ALTER TABLE "profile_questions" ADD COLUMN IF NOT EXISTS "hiddenBy" VARCHAR(100);
ALTER TABLE "profile_questions" ADD COLUMN IF NOT EXISTS "upvoteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "profile_questions" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);

-- Tidak di-backfill: belum ada upvote di sistem lama, jadi 0 adalah nilai jujur.

-- ------------------------------------------------------------
-- 3. Kolom baru di profile_question_comments
-- ------------------------------------------------------------
ALTER TABLE "profile_question_comments" ADD COLUMN IF NOT EXISTS "hiddenReason" "ContentHiddenReason";
ALTER TABLE "profile_question_comments" ADD COLUMN IF NOT EXISTS "hiddenAt" TIMESTAMP(3);
ALTER TABLE "profile_question_comments" ADD COLUMN IF NOT EXISTS "hiddenBy" VARCHAR(100);

-- ------------------------------------------------------------
-- 4. Tabel profile_question_upvotes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "profile_question_upvotes" (
  "id"         TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "profile_question_upvotes_pkey" PRIMARY KEY ("id")
);

-- Unique (userId, questionId): upvote ganda mustahil walau dua request balapan.
CREATE UNIQUE INDEX IF NOT EXISTS "profile_question_upvotes_userId_questionId_key"
  ON "profile_question_upvotes"("userId", "questionId");
CREATE INDEX IF NOT EXISTS "profile_question_upvotes_questionId_createdAt_id_idx"
  ON "profile_question_upvotes"("questionId", "createdAt", "id");
CREATE INDEX IF NOT EXISTS "profile_question_upvotes_userId_idx"
  ON "profile_question_upvotes"("userId");

DO $$ BEGIN
  ALTER TABLE "profile_question_upvotes"
    ADD CONSTRAINT "profile_question_upvotes_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "profile_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "profile_question_upvotes"
    ADD CONSTRAINT "profile_question_upvotes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ------------------------------------------------------------
-- 4b. Backfill defensif sebelum constraint dipasang
-- ------------------------------------------------------------
-- `isHidden` sebelumnya bisa diset tanpa alasan (walau tidak ada kode yang
-- melakukannya). Memberi label OTHER pada baris yang terlanjur tersembunyi
-- membuat ADD CONSTRAINT di langkah 5 tidak mungkin gagal di production.
UPDATE "profile_questions"
SET "hiddenReason" = 'OTHER', "hiddenAt" = COALESCE("hiddenAt", "updatedAt")
WHERE "isHidden" = true AND "hiddenReason" IS NULL;

UPDATE "profile_question_comments"
SET "hiddenReason" = 'OTHER', "hiddenAt" = COALESCE("hiddenAt", "updatedAt")
WHERE "isHidden" = true AND "hiddenReason" IS NULL;

-- ------------------------------------------------------------
-- 5. Invariant moderasi (pola showcase_comment_hidden_fields_consistent)
-- ------------------------------------------------------------
-- hiddenReason/hiddenAt hanya relevan bila isHidden true, dan menyembunyikan
-- WAJIB menyebutkan alasan kategorisnya.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'profile_question_hidden_fields_consistent'
  ) THEN
    ALTER TABLE "profile_questions" ADD CONSTRAINT profile_question_hidden_fields_consistent
      CHECK (
        ("isHidden" = false AND "hiddenReason" IS NULL AND "hiddenAt" IS NULL)
        OR ("isHidden" = true AND "hiddenReason" IS NOT NULL)
      );
    RAISE NOTICE 'Added: profile_question_hidden_fields_consistent';
  ELSE
    RAISE NOTICE 'Exists: profile_question_hidden_fields_consistent';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'profile_question_comment_hidden_fields_consistent'
  ) THEN
    ALTER TABLE "profile_question_comments" ADD CONSTRAINT profile_question_comment_hidden_fields_consistent
      CHECK (
        ("isHidden" = false AND "hiddenReason" IS NULL AND "hiddenAt" IS NULL)
        OR ("isHidden" = true AND "hiddenReason" IS NOT NULL)
      );
    RAISE NOTICE 'Added: profile_question_comment_hidden_fields_consistent';
  ELSE
    RAISE NOTICE 'Exists: profile_question_comment_hidden_fields_consistent';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 6. Index untuk job reminder & urutan "terpopuler"
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "profile_questions_answeredAt_reminderSentAt_createdAt_idx"
  ON "profile_questions"("answeredAt", "reminderSentAt", "createdAt");
CREATE INDEX IF NOT EXISTS "profile_questions_receiverId_isPublic_isHidden_upvoteCount_idx"
  ON "profile_questions"("receiverId", "isPublic", "isHidden", "upvoteCount");
