-- Feedback pengguna (G-001, 2026-09-26): backend untuk POST /v1/feedback
-- yang dipanggil frontend lib/feedback.ts (sebelumnya 404).
-- Aditif penuh: tabel baru + relasi opsional ke users (onDelete SetNull,
-- feedback guest tetap tersimpan bila akun dihapus).

-- CreateTable
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "category" VARCHAR(100) NOT NULL,
    "message" TEXT NOT NULL,
    "contact" VARCHAR(320),
    "rating" INTEGER,
    "platform" VARCHAR(32) NOT NULL DEFAULT 'app',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_userId_idx" ON "feedback"("userId");

-- CreateIndex
CREATE INDEX "feedback_createdAt_idx" ON "feedback"("createdAt");

-- CreateIndex
CREATE INDEX "feedback_category_createdAt_idx" ON "feedback"("category", "createdAt");

-- AddForeignKey
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
