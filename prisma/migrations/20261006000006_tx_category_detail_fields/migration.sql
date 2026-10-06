-- TX-UNIFIED-V2 (P0-A, 2026-10-06): kolom detail kategori untuk payload
-- "Buat Transaksi" frontend (scheduledDate, itemCondition,
-- conditionDescription, deliveryMethod, warrantyDays, deliverables,
-- serviceLocation, cancellationPolicy, slotId).
--
-- Additive-only, semua nullable — aman untuk data existing & rollback.
-- Tanpa backfill: data lama tetap NULL (ditampilkan sebagai "tidak diisi").

ALTER TABLE "orders" ADD COLUMN "scheduledDate" TIMESTAMPTZ(3);
ALTER TABLE "orders" ADD COLUMN "itemCondition" VARCHAR(10);
ALTER TABLE "orders" ADD COLUMN "conditionDescription" VARCHAR(500);
ALTER TABLE "orders" ADD COLUMN "deliveryMethod" VARCHAR(20);
ALTER TABLE "orders" ADD COLUMN "warrantyDays" INTEGER;
ALTER TABLE "orders" ADD COLUMN "deliverables" VARCHAR(1000);
ALTER TABLE "orders" ADD COLUMN "serviceLocation" VARCHAR(200);
ALTER TABLE "orders" ADD COLUMN "cancellationPolicy" VARCHAR(1000);
ALTER TABLE "orders" ADD COLUMN "slotId" VARCHAR(100);
