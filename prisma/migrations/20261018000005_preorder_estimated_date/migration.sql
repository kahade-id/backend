-- TX-UNIFIED-V2 (P1-3, 2026-10-06): kolom preorderEstimatedDate untuk PREORDER.
--
-- Migrasi ini HANYA menambah preorderEstimatedDate. Tiga enum/kolom dimensi
-- (FulfillmentType, ParticipantMode, OrderCategory + fulfillment,
-- participantMode, category) + backfill sudah dibuat oleh migrasi
-- 20261018000004_tx_unified_v2 yang selalu di-apply lebih dulu
-- (urutan leksikografis). Versi sebelumnya dari file ini menduplikasi
-- 00004 sehingga gagal dengan "type already exists" — diperbaiki 2026-10-06.
--
-- Additive-only, nullable — aman untuk data existing & rollback.

ALTER TABLE "orders" ADD COLUMN "preorderEstimatedDate" TIMESTAMPTZ(3);
