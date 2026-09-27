-- Migration: GAP-D retur / tukar barang purnajual (G201–G225).
-- Prinsip: append-only. Hanya CREATE TYPE / CREATE TABLE / CREATE INDEX /
-- seed config kebijakan. TIDAK menyentuh tabel existing (orders, wallets, ...).
-- FK ke "orders"("id") dengan ON DELETE RESTRICT agar riwayat retur tidak
-- hilang saat order di-soft-delete.

-- 1. Enum baru.
CREATE TYPE "ReturnStatus" AS ENUM (
  'REQUESTED', 'SELLER_REVIEW', 'CLARIFICATION_NEEDED', 'APPROVED', 'REJECTED',
  'RETURN_SHIPPING', 'RECEIVED', 'RESOLVED_REFUND', 'RESOLVED_EXCHANGE',
  'RESOLVED_REPAIR', 'ESCALATED', 'CANCELLED', 'EXPIRED'
);
CREATE TYPE "ReturnReasonCode" AS ENUM (
  'BARANG_RUSAK', 'BARANG_TIDAK_SESUAI_DESKRIPSI', 'BARANG_TIDAK_LENGKAP',
  'BARANG_PALSU', 'SALAH_KIRIM_VARIAN', 'BARANG_KEDALUWARSA',
  'KEMASAN_RUSAK_PARAH', 'LAINNYA'
);
CREATE TYPE "ReturnRejectReasonCode" AS ENUM (
  'MELEWATI_BATAS_WAKTU', 'BARANG_TIDAK_RUSAK', 'KLAIM_TIDAK_VALID',
  'BUKTI_TIDAK_CUKUP', 'BARANG_SUDAH_DIGUNAKAN', 'KERUSAKAN_AKIBAT_PEMBELI',
  'DILUAR_CAKUPAN_KEBIJAKAN', 'LAINNYA'
);
CREATE TYPE "ReturnResolutionType" AS ENUM ('REFUND', 'EXCHANGE', 'REPAIR', 'MUTUAL_AGREED');
CREATE TYPE "RefundApprovalStatus" AS ENUM ('PENDING', 'EXECUTING', 'EXECUTED', 'FAILED');
CREATE TYPE "ReturnActorType" AS ENUM ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM');

-- 2. Kebijakan retur (G201) — seed config per tipe order.
CREATE TABLE "return_policies" (
  "id" TEXT NOT NULL,
  "orderType" "OrderType" NOT NULL,
  "category" TEXT,
  "returnWindowDays" INTEGER NOT NULL DEFAULT 7,
  "sellerResponseHours" INTEGER NOT NULL DEFAULT 72,
  "shipBackWindowDays" INTEGER NOT NULL DEFAULT 7,
  "clarificationWindowDays" INTEGER NOT NULL DEFAULT 3,
  "requireReturnShipment" BOOLEAN NOT NULL DEFAULT true,
  "maxRefundBps" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "return_policies_orderType_category_key" ON "return_policies"("orderType", "category");
-- Kebijakan default (category IS NULL) hanya boleh SATU per orderType.
-- @@unique([orderType, category]) di Prisma tidak cukup: di PostgreSQL NULL
-- dianggap berbeda sehingga (orderType, NULL) bisa duplikat. getPolicy()
-- memakai findFirst sehingga duplikat akan ambigu — index parsial ini
-- menguncinya di level DB.
CREATE UNIQUE INDEX "return_policies_orderType_default_uniq" ON "return_policies"("orderType") WHERE "category" IS NULL;

-- 3. Pengajuan retur.
CREATE TABLE "return_requests" (
  "id" TEXT NOT NULL,
  "returnId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "itemRef" TEXT,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "status" "ReturnStatus" NOT NULL DEFAULT 'REQUESTED',
  "reasonCode" "ReturnReasonCode" NOT NULL,
  "reasonDetail" TEXT,
  "resolutionType" "ReturnResolutionType",
  "refundAmount" BIGINT,
  "sellerRespondBy" TIMESTAMPTZ(3),
  "rejectReasonCode" "ReturnRejectReasonCode",
  "rejectNote" TEXT,
  "clarificationQuestion" TEXT,
  "returnInstructions" TEXT,
  "shipBy" TIMESTAMPTZ(3),
  "returnTrackingNumber" TEXT,
  "returnCourier" TEXT,
  "receivedAt" TIMESTAMPTZ(3),
  "receivedNote" TEXT,
  "disputeId" TEXT,
  "approvedAt" TIMESTAMPTZ(3),
  "rejectedAt" TIMESTAMPTZ(3),
  "resolvedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "expiredAt" TIMESTAMPTZ(3),
  "escalatedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "return_requests_returnId_key" ON "return_requests"("returnId");
CREATE INDEX "return_requests_orderId_idx" ON "return_requests"("orderId");
CREATE INDEX "return_requests_buyerId_status_idx" ON "return_requests"("buyerId", "status");
CREATE INDEX "return_requests_sellerId_status_idx" ON "return_requests"("sellerId", "status");
CREATE INDEX "return_requests_status_sellerRespondBy_idx" ON "return_requests"("status", "sellerRespondBy");
CREATE INDEX "return_requests_status_createdAt_idx" ON "return_requests"("status", "createdAt");
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- G218: cegah pengajuan ganda — unik per (order, item) selama ada case AKTIF.
-- Partial index: status terminal dikecualikan sehingga pengajuan ulang setelah
-- REJECTED/CANCELLED/EXPIRED/resolved tetap dimungkinkan. COALESCE menangani
-- itemRef NULL (retur seluruh order) karena NULL != NULL di unique index.
CREATE UNIQUE INDEX "return_requests_order_item_active_uniq"
  ON "return_requests" ("orderId", COALESCE("itemRef", ''))
  WHERE "status" NOT IN (
    'REJECTED', 'CANCELLED', 'EXPIRED',
    'RESOLVED_REFUND', 'RESOLVED_EXCHANGE', 'RESOLVED_REPAIR', 'ESCALATED'
  );

-- 4. Lampiran bukti (G205, retensi G222).
CREATE TABLE "return_attachments" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "fileKey" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "uploadedBy" TEXT NOT NULL,
  "retainUntil" TIMESTAMPTZ(3),
  "purgedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_attachments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "return_attachments_returnRequestId_idx" ON "return_attachments"("returnRequestId");
CREATE INDEX "return_attachments_retainUntil_idx" ON "return_attachments"("retainUntil");
ALTER TABLE "return_attachments" ADD CONSTRAINT "return_attachments_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Negosiasi / catatan dua pihak (G216).
CREATE TABLE "return_notes" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "authorRole" "ReturnActorType" NOT NULL,
  "message" TEXT NOT NULL,
  "visibleToBoth" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_notes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "return_notes_returnRequestId_createdAt_idx" ON "return_notes"("returnRequestId", "createdAt");
ALTER TABLE "return_notes" ADD CONSTRAINT "return_notes_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. Timeline audit append-only (G214, G220).
CREATE TABLE "return_timeline" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "fromStatus" "ReturnStatus",
  "toStatus" "ReturnStatus",
  "actorId" TEXT,
  "actorRole" "ReturnActorType" NOT NULL DEFAULT 'SYSTEM',
  "metadata" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_timeline_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "return_timeline_returnRequestId_createdAt_idx" ON "return_timeline"("returnRequestId", "createdAt");
ALTER TABLE "return_timeline" ADD CONSTRAINT "return_timeline_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 7. Event tracking paket retur (G214).
CREATE TABLE "return_shipment_events" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "trackingNumber" TEXT NOT NULL,
  "courier" TEXT,
  "status" TEXT NOT NULL,
  "location" TEXT,
  "eventAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_shipment_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "return_shipment_events_returnRequestId_eventAt_idx" ON "return_shipment_events"("returnRequestId", "eventAt");
ALTER TABLE "return_shipment_events" ADD CONSTRAINT "return_shipment_events_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 8. Persetujuan refund idempoten (G210) — approval TIDAK memanggil provider.
CREATE TABLE "return_refund_approvals" (
  "id" TEXT NOT NULL,
  "returnRequestId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "status" "RefundApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "approvedBy" TEXT NOT NULL,
  "approvedByRole" "ReturnActorType" NOT NULL,
  "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "executedAt" TIMESTAMPTZ(3),
  "failureReason" TEXT,
  "walletTxIds" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "return_refund_approvals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "return_refund_approvals_returnRequestId_key" ON "return_refund_approvals"("returnRequestId");
CREATE UNIQUE INDEX "return_refund_approvals_idempotencyKey_key" ON "return_refund_approvals"("idempotencyKey");
ALTER TABLE "return_refund_approvals" ADD CONSTRAINT "return_refund_approvals_returnRequestId_fkey"
  FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 9. Seed kebijakan default (G201). Idempoten via ON CONFLICT DO NOTHING.
INSERT INTO "return_policies"
  ("id", "orderType", "category", "returnWindowDays", "sellerResponseHours",
   "shipBackWindowDays", "clarificationWindowDays", "requireReturnShipment", "maxRefundBps", "isActive")
VALUES
  ('seed-physical', 'PHYSICAL_GOODS', NULL, 7, 72, 7, 3, true, NULL, true),
  ('seed-digital',  'DIGITAL_GOODS',  NULL, 3, 48, 0, 3, false, NULL, true),
  ('seed-service',  'SERVICE',        NULL, 3, 48, 0, 3, false, NULL, true),
  ('seed-other',    'OTHER',          NULL, 7, 72, 7, 3, true, NULL, true)
ON CONFLICT DO NOTHING;
