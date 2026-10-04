-- POIN 2 (2026-10-04) — unifikasi transaksi escrow: kolom orderKind di orders.
--
-- orderKind = dimensi JENIS TRANSAKSI (DIRECT/JASTIP/PATUNGAN/SERVICE_BOOKING),
-- BERBEDA dengan orderType yang sudah ada (dimensi jenis barang:
-- PHYSICAL_GOODS/DIGITAL_GOODS/SERVICE/OTHER) — orderType TIDAK disentuh.
-- Default DIRECT mempertahankan perilaku lama untuk semua order existing.
--
-- Backfill deterministik dari tautan yang sudah ada:
--   - order tertaut ke jastip_participants.orderId   → JASTIP
--   - order tertaut ke patungan_participants.orderId → PATUNGAN
--   - order tertaut ke service_slot_bookings.orderId → SERVICE_BOOKING
--   - sisanya tetap DIRECT
-- Unique constraint orderId di kedua tabel participant menjamin satu order
-- tidak tertaut ke dua peserta; urutan UPDATE di bawah defensif bila
-- service_slot_bookings (tanpa unique) tumpang tindih.

CREATE TYPE "OrderKind" AS ENUM ('DIRECT', 'JASTIP', 'PATUNGAN', 'SERVICE_BOOKING');

ALTER TABLE "orders" ADD COLUMN "orderKind" "OrderKind" NOT NULL DEFAULT 'DIRECT';

CREATE INDEX "orders_orderKind_idx" ON "orders"("orderKind");

UPDATE "orders" o
SET "orderKind" = 'JASTIP'
WHERE EXISTS (
  SELECT 1 FROM "jastip_participants" jp WHERE jp."orderId" = o."id"
);

UPDATE "orders" o
SET "orderKind" = 'PATUNGAN'
WHERE EXISTS (
  SELECT 1 FROM "patungan_participants" pp WHERE pp."orderId" = o."id"
);

UPDATE "orders" o
SET "orderKind" = 'SERVICE_BOOKING'
WHERE EXISTS (
  SELECT 1 FROM "service_slot_bookings" sb WHERE sb."orderId" = o."id"
);
