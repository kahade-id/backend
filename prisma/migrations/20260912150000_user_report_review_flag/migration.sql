-- ============================================================
-- Section 6: sinyal moderasi internal dari agregasi laporan user
-- ============================================================
-- Menambah dua kolom pada `users`:
--   flaggedForReview    BOOLEAN NOT NULL DEFAULT false
--   flaggedForReviewAt  TIMESTAMP(3)  (nullable)
--
-- Di-set oleh ReportFlagService ketika >= 3 laporan dari reporter BERBEDA
-- masuk dalam jendela 24 jam untuk satu target. Ini murni penanda antrean
-- moderasi untuk admin:
--   * TIDAK ada auto-ban, auto-suspend, atau pembatasan fitur apa pun;
--   * TIDAK pernah diekspos ke user lain (hanya permukaan admin);
--   * keputusan (ban / teguran / abaikan) tetap milik admin.
--
-- Aman untuk deploy berjalan: kolom boolean ber-default false dan kolom
-- timestamp nullable (prisma/MIGRATION_SAFETY.md rule 3), tidak ada rename,
-- tidak ada drop, tidak ada perubahan tipe. Kode lama yang tidak mengenal
-- kolom ini tetap berjalan normal.
-- ============================================================

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "flaggedForReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "flaggedForReviewAt" TIMESTAMP(3);

-- Antrean moderasi admin: WHERE "flaggedForReview" = true
-- ORDER BY "flaggedForReviewAt" DESC. Selektivitas boolean ini tinggi di
-- praktik (hanya sedikit user yang pernah terflag) sehingga index tetap
-- berguna meski kolomnya boolean.
CREATE INDEX IF NOT EXISTS "users_flaggedForReview_flaggedForReviewAt_idx"
  ON "users"("flaggedForReview", "flaggedForReviewAt");
