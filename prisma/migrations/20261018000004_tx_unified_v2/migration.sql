-- TX-UNIFIED-V2 (2026-10-06) — 3 dimensi independen pengganti OrderKind flat.
--
-- Model baru (keputusan produk 2026-10-05):
--   fulfillment:     BIASA | PREORDER   (waktu pemenuhan; Jasa pakai tanggal, bukan label)
--   participantMode: SINGLE | GROUP     (1-by-1 vs 1-by-N patungan 2-100)
--   category:        FISIK | DIGITAL | JASA   (TIDAK ada "LAINNYA")
--
-- Kolom & enum OrderKind LAMA dipertahankan (dual-write) untuk backward compat
-- selama frontend+admin migrasi; dihapus di fase terpisah.
--
-- Backfill deterministik dari orderKind lama + orderType (dimensi barang):
--   fulfillment:
--     JASTIP → PREORDER   (jastip = preorder; trip = batch preorder)
--     lainnya → BIASA      (default; PATUNGAN soal peserta bukan waktu)
--   participantMode:
--     PATUNGAN → GROUP
--     lainnya  → SINGLE
--   category (dari orderType yang sudah ada):
--     PHYSICAL_GOODS → FISIK
--     DIGITAL_GOODS  → DIGITAL
--     SERVICE        → JASA
--     OTHER          → FISIK (default aman; TIDAK ada kategori LAINNYA di model baru)
--
-- Idempotent: semua UPDATE bersyarat eksplisit; aman dijalankan ulang.

CREATE TYPE "FulfillmentType" AS ENUM ('BIASA', 'PREORDER');
CREATE TYPE "ParticipantMode" AS ENUM ('SINGLE', 'GROUP');
CREATE TYPE "OrderCategory" AS ENUM ('FISIK', 'DIGITAL', 'JASA');

ALTER TABLE "orders" ADD COLUMN "fulfillment" "FulfillmentType" NOT NULL DEFAULT 'BIASA';
ALTER TABLE "orders" ADD COLUMN "participantMode" "ParticipantMode" NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "orders" ADD COLUMN "category" "OrderCategory" NOT NULL DEFAULT 'FISIK';

CREATE INDEX "orders_fulfillment_idx" ON "orders"("fulfillment");
CREATE INDEX "orders_participantMode_idx" ON "orders"("participantMode");
CREATE INDEX "orders_category_idx" ON "orders"("category");

-- fulfillment: JASTIP → PREORDER
UPDATE "orders"
SET "fulfillment" = 'PREORDER'
WHERE "orderKind" = 'JASTIP';

-- participantMode: PATUNGAN → GROUP
UPDATE "orders"
SET "participantMode" = 'GROUP'
WHERE "orderKind" = 'PATUNGAN';

-- category dari orderType (dimensi barang yang sudah ada)
UPDATE "orders" SET "category" = 'FISIK'   WHERE "orderType" = 'PHYSICAL_GOODS';
UPDATE "orders" SET "category" = 'DIGITAL' WHERE "orderType" = 'DIGITAL_GOODS';
UPDATE "orders" SET "category" = 'JASA'    WHERE "orderType" = 'SERVICE';
-- OTHER → FISIK (default kolom, tidak perlu UPDATE)
