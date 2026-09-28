-- Lokasi presisi buyer saat order dibuat (fraud checking di admin).
-- ADDITIVE-ONLY: hanya menambah kolom nullable ke tabel "orders".
-- Data existing tidak tersentuh (semua NULL = order dibuat sebelum fitur ini
-- atau buyer menolak izin lokasi).
-- Koordinat = PII sensitif -> disimpan terenkripsi AES-GCM (ciphertext),
-- mengikuti standar codebase (model Address, addresses.service.ts).
-- buyerLocationCapturedAt: metadata waktu (bukan PII inti), plaintext.
ALTER TABLE "orders" ADD COLUMN "buyerLatitude" TEXT;
ALTER TABLE "orders" ADD COLUMN "buyerLongitude" TEXT;
ALTER TABLE "orders" ADD COLUMN "buyerLocationAccuracy" TEXT;
ALTER TABLE "orders" ADD COLUMN "buyerLocationCapturedAt" TIMESTAMPTZ(6);
