-- Soft delete untuk UserShowcase: hapus = set deletedAt, bisa dipulihkan 30 hari
ALTER TABLE "user_showcases" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX "user_showcases_deletedAt_idx" ON "user_showcases"("deletedAt");
CREATE INDEX "user_showcases_userId_deletedAt_idx" ON "user_showcases"("userId", "deletedAt");
