-- TX-UNIFIED-V2 (P1-3, 2026-10-06): 3 dimensi independen pengganti OrderKind flat
-- + kolom preorderEstimatedDate untuk PREORDER.
--
-- Backfill deterministik & idempotent (aman diulang):
--   JASTIP          -> fulfillment=PREORDER (trip = batch preorder)
--   PATUNGAN        -> participantMode=GROUP
--   SERVICE_BOOKING -> category=JASA
--   category dari orderType untuk sisanya:
--     PHYSICAL_GOODS -> FISIK, DIGITAL_GOODS -> DIGITAL, SERVICE -> JASA,
--     OTHER -> FISIK (tidak ada kategori LAINNYA di model baru; keputusan produk)

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('BIASA', 'PREORDER');
CREATE TYPE "ParticipantMode" AS ENUM ('SINGLE', 'GROUP');
CREATE TYPE "OrderCategory" AS ENUM ('FISIK', 'DIGITAL', 'JASA');

-- AlterTable: kolom baru dengan default aman (NOT NULL + DEFAULT agar
-- tidak ada baris NULL; default = perilaku lama)
ALTER TABLE "orders" ADD COLUMN "fulfillment" "FulfillmentType" NOT NULL DEFAULT 'BIASA';
ALTER TABLE "orders" ADD COLUMN "participantMode" "ParticipantMode" NOT NULL DEFAULT 'SINGLE';
ALTER TABLE "orders" ADD COLUMN "category" "OrderCategory" NOT NULL DEFAULT 'FISIK';
ALTER TABLE "orders" ADD COLUMN "preorderEstimatedDate" TIMESTAMPTZ(3);

-- Backfill dimensi dari orderKind lama
UPDATE "orders" SET "fulfillment" = 'PREORDER' WHERE "orderKind" = 'JASTIP';
UPDATE "orders" SET "participantMode" = 'GROUP' WHERE "orderKind" = 'PATUNGAN';
UPDATE "orders" SET "category" = 'JASA' WHERE "orderKind" = 'SERVICE_BOOKING';

-- Backfill category dari orderType (untuk yang bukan SERVICE_BOOKING)
UPDATE "orders" SET "category" = 'DIGITAL' WHERE "orderType" = 'DIGITAL_GOODS' AND "orderKind" <> 'SERVICE_BOOKING';
UPDATE "orders" SET "category" = 'JASA' WHERE "orderType" = 'SERVICE' AND "orderKind" <> 'SERVICE_BOOKING';
-- PHYSICAL_GOODS dan OTHER -> FISIK (sudah default, eksplisit untuk kejelasan)
UPDATE "orders" SET "category" = 'FISIK' WHERE "orderType" IN ('PHYSICAL_GOODS', 'OTHER') AND "orderKind" <> 'SERVICE_BOOKING';

-- CreateIndex
CREATE INDEX "orders_fulfillment_idx" ON "orders"("fulfillment");
