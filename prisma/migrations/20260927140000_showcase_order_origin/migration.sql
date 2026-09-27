-- SH-B-011 (audit etalase 2026-09-27): asal etalase pada Order/OrderLink.
-- Additive-only: kolom nullable + FK onDelete SET NULL + index. Tidak ada
-- perubahan kolom existing; alur escrow/wallet tidak tersentuh.
-- priceSnapshot = RUPIAH integer (bukan sen ×100 seperti orderValue) —
-- harga etalase saat link dibuat, hanya untuk pencatatan/audit.

-- AlterTable
ALTER TABLE "order_links" ADD COLUMN "showcaseId" TEXT,
ADD COLUMN "priceSnapshot" BIGINT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "showcaseId" TEXT,
ADD COLUMN "priceSnapshot" BIGINT;

-- CreateIndex
CREATE INDEX "order_links_showcaseId_idx" ON "order_links"("showcaseId");

-- CreateIndex
CREATE INDEX "orders_showcaseId_idx" ON "orders"("showcaseId");

-- AddForeignKey
ALTER TABLE "order_links" ADD CONSTRAINT "order_links_showcaseId_fkey" FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_showcaseId_fkey" FOREIGN KEY ("showcaseId") REFERENCES "user_showcases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
