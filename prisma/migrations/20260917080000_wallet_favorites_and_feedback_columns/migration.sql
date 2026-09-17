-- Gap schema→database yang terbukti dari produksi:
-- 1. wallet_favorite_recipients: model ada di schema.prisma + dipakai
--    wallet.service.ts (raw SQL) + frontend (favorite-recipients) tapi TIDAK
--    punya migrasi → P2010 "relation does not exist" (2026-09-16 15:24).
-- 2. faq_items.helpfulCount/notHelpfulCount & support_tickets.rating/
--    ratingComment: dipakai help-center & support service (dengan fallback),
--    dibuat aditif agar schema dan DB identik (prisma migrate diff bersih).

-- CreateTable
CREATE TABLE "wallet_favorite_recipients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "label" VARCHAR(50),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_favorite_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_favorite_recipients_userId_idx" ON "wallet_favorite_recipients"("userId");

-- CreateIndex
CREATE INDEX "wallet_favorite_recipients_recipientId_idx" ON "wallet_favorite_recipients"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_favorite_recipients_userId_recipientId_key" ON "wallet_favorite_recipients"("userId", "recipientId");

-- AddForeignKey
ALTER TABLE "wallet_favorite_recipients" ADD CONSTRAINT "wallet_favorite_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_favorite_recipients" ADD CONSTRAINT "wallet_favorite_recipients_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (aditif, aman untuk data lama)
ALTER TABLE "faq_items" ADD COLUMN IF NOT EXISTS "helpfulCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "notHelpfulCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "rating" INTEGER,
ADD COLUMN IF NOT EXISTS "ratingComment" TEXT;

-- KYC index dari diff (non-kritis tapi bagian dari schema)
CREATE INDEX IF NOT EXISTS "kyc_requests_ktpNumberHash_idx" ON "kyc_requests"("ktpNumberHash");
