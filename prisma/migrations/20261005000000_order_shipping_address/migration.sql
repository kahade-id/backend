-- TRX-009 (UI/UX audit 2026-09-28): alamat pengiriman untuk order barang fisik.
-- ADDITIVE-ONLY: hanya menambah kolom nullable ke tabel "orders" (tanpa FK
-- constraint — soft FK mengikuti pola Address.userId). Data existing tidak
-- tersentuh (semua NULL = order dibuat sebelum fitur ini / non-fisik).
-- Snapshot diambil saat order dibuat, jadi riwayat order tidak berubah bila
-- buku alamat diedit/dihapus. Kolom PII mengikuti standar AES-GCM codebase
-- (lihat model Address): ciphertext disimpan apa adanya.
ALTER TABLE "orders" ADD COLUMN "shippingAddressId" TEXT;
ALTER TABLE "orders" ADD COLUMN "shippingRecipientName" TEXT;
ALTER TABLE "orders" ADD COLUMN "shippingPhone" TEXT;
ALTER TABLE "orders" ADD COLUMN "shippingAddressLine" TEXT;
ALTER TABLE "orders" ADD COLUMN "shippingCity" TEXT;
ALTER TABLE "orders" ADD COLUMN "shippingProvince" TEXT;
ALTER TABLE "orders" ADD COLUMN "shippingPostalCode" TEXT;
