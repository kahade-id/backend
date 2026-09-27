-- Migration: GAP D part C — Integrasi kurir & tracking otomatis (G226–G250).
--
-- APPEND-ONLY: hanya CREATE TYPE / CREATE TABLE / INSERT seed baru.
-- TIDAK ADA perubahan pada tabel existing (orders, wallet, dsb).
--
-- Catatan penamaan direktori: timestamp 20260927050000 sudah dipakai worker
-- paralel (gap_e_admin_ops), jadi migrasi ini memakai 20260927060000 agar
-- tidak bertabrakan.
--
-- Katalog seed (G227): JNE, J&T, SiCepat, GoSend, AnterAja, Paxel — SEMUA
-- NONAKTIF (enabled=false). Aktivasi via feature flag per provider/wilayah
-- (G249) oleh admin; TIDAK ADA kredensial provider nyata di seed ini.

-- ============================================================
-- 1. ENUMS
-- ============================================================
CREATE TYPE "ShipmentStatus" AS ENUM (
  'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY',
  'DELIVERED', 'EXCEPTION', 'RETURNED', 'UNKNOWN'
);

CREATE TYPE "ShipmentMode" AS ENUM ('PICKUP', 'DROPOFF');

CREATE TYPE "ShippingCostBearer" AS ENUM ('SELLER', 'BUYER', 'SPLIT');

CREATE TYPE "ShipmentBookingState" AS ENUM ('DRAFT', 'BOOKED', 'FAILED', 'VOIDED');

CREATE TYPE "CourierBillStatus" AS ENUM ('DRAFT', 'MATCHED', 'MISMATCH', 'ACKNOWLEDGED');

CREATE TYPE "ShippingRefundStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'PAID');

-- ============================================================
-- 2. TABLES
-- ============================================================

-- Katalog kurir + layanan (G227).
CREATE TABLE "courier_services" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "providerCode"   TEXT NOT NULL,
  "serviceCode"    TEXT NOT NULL,
  "serviceName"    TEXT NOT NULL,
  "description"    TEXT,
  "enabled"        BOOLEAN NOT NULL DEFAULT false,
  "regions"        TEXT[] NOT NULL DEFAULT '{}',
  "supportsPickup"  BOOLEAN NOT NULL DEFAULT true,
  "supportsDropoff" BOOLEAN NOT NULL DEFAULT true,
  "slaGraceDays"   INTEGER NOT NULL DEFAULT 2,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "courier_services_provider_service_key" UNIQUE ("providerCode", "serviceCode")
);
CREATE INDEX "courier_services_providerCode_idx" ON "courier_services" ("providerCode");
CREATE INDEX "courier_services_enabled_idx" ON "courier_services" ("enabled");

-- Feature flag per provider + wilayah (G249).
CREATE TABLE "courier_region_flags" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "providerCode" TEXT NOT NULL,
  "region"       TEXT NOT NULL,
  "enabled"      BOOLEAN NOT NULL DEFAULT false,
  "note"         TEXT,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "courier_region_flags_provider_region_key" UNIQUE ("providerCode", "region")
);
CREATE INDEX "courier_region_flags_providerCode_idx" ON "courier_region_flags" ("providerCode");

-- Entitas pengiriman (G233).
CREATE TABLE "shipments" (
  "id"                   TEXT NOT NULL PRIMARY KEY,
  "orderId"              TEXT NOT NULL UNIQUE,
  "sellerId"             TEXT NOT NULL,
  "buyerId"              TEXT NOT NULL,
  "providerCode"         TEXT NOT NULL,
  "serviceCode"          TEXT,
  "mode"                 "ShipmentMode" NOT NULL DEFAULT 'PICKUP',
  "bookingState"         "ShipmentBookingState" NOT NULL DEFAULT 'DRAFT',
  "status"               "ShipmentStatus" NOT NULL DEFAULT 'CREATED',
  "providerBookingId"    TEXT,
  "trackingNumber"       TEXT,
  "labelFileKey"         TEXT,
  "labelMimeType"        TEXT,
  "costBearer"           "ShippingCostBearer" NOT NULL DEFAULT 'SELLER',
  "estimatedCost"        BIGINT NOT NULL DEFAULT 0,
  "actualCost"           BIGINT,
  "currency"             TEXT NOT NULL DEFAULT 'IDR',
  "refundedAmount"       BIGINT NOT NULL DEFAULT 0,
  "weightGrams"          INTEGER,
  "originCity"           TEXT,
  "originPostalCode"     TEXT,
  "destCity"             TEXT,
  "destPostalCode"       TEXT,
  "originDetail"         JSONB,
  "destDetail"           JSONB,
  "etaMinDays"           INTEGER,
  "etaMaxDays"           INTEGER,
  "slaDueAt"             TIMESTAMP(3),
  "lastEventAt"          TIMESTAMP(3),
  "lastEventRaw"         TEXT,
  "staleAlertSentAt"     TIMESTAMP(3),
  "isManual"             BOOLEAN NOT NULL DEFAULT false,
  "manualTrackingNumber" TEXT,
  "manualCourierName"    TEXT,
  "voidedAt"             TIMESTAMP(3),
  "voidReason"           TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "shipments_orderId_idx" ON "shipments" ("orderId");
CREATE INDEX "shipments_sellerId_idx" ON "shipments" ("sellerId");
CREATE INDEX "shipments_buyerId_idx" ON "shipments" ("buyerId");
CREATE INDEX "shipments_providerCode_idx" ON "shipments" ("providerCode");
CREATE INDEX "shipments_trackingNumber_idx" ON "shipments" ("trackingNumber");
CREATE INDEX "shipments_status_idx" ON "shipments" ("status");
CREATE INDEX "shipments_bookingState_idx" ON "shipments" ("bookingState");
CREATE INDEX "shipments_status_lastEventAt_idx" ON "shipments" ("status", "lastEventAt");

-- Event tracking (G236/G237).
CREATE TABLE "shipment_events" (
  "id"              TEXT NOT NULL PRIMARY KEY,
  "shipmentId"      TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "providerCode"    TEXT NOT NULL,
  "rawStatus"       TEXT NOT NULL,
  "status"          "ShipmentStatus" NOT NULL,
  "locationMasked"  TEXT,
  "description"     TEXT,
  "occurredAt"      TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipment_events_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shipment_events_shipment_event_key" UNIQUE ("shipmentId", "providerEventId")
);
CREATE INDEX "shipment_events_shipmentId_createdAt_idx" ON "shipment_events" ("shipmentId", "createdAt");

-- Log webhook mentah (G235).
CREATE TABLE "courier_webhook_logs" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "providerCode"   TEXT NOT NULL,
  "shipmentId"     TEXT,
  "idempotencyKey" TEXT,
  "signatureValid" BOOLEAN NOT NULL,
  "payloadHash"    TEXT NOT NULL,
  "outcome"        TEXT NOT NULL DEFAULT 'RECEIVED',
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "courier_webhook_logs_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "courier_webhook_logs_providerCode_createdAt_idx" ON "courier_webhook_logs" ("providerCode", "createdAt");
CREATE INDEX "courier_webhook_logs_idempotencyKey_idx" ON "courier_webhook_logs" ("idempotencyKey");

-- Tagihan provider untuk rekonsiliasi (G248).
CREATE TABLE "courier_provider_bills" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "providerCode"   TEXT NOT NULL,
  "period"         TEXT NOT NULL,
  "currency"       TEXT NOT NULL DEFAULT 'IDR',
  "billedAmount"   BIGINT NOT NULL,
  "recordedAmount" BIGINT NOT NULL DEFAULT 0,
  "status"         "CourierBillStatus" NOT NULL DEFAULT 'DRAFT',
  "notes"          TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "courier_provider_bills_provider_period_key" UNIQUE ("providerCode", "period")
);
CREATE INDEX "courier_provider_bills_providerCode_idx" ON "courier_provider_bills" ("providerCode");

CREATE TABLE "courier_bill_lines" (
  "id"             TEXT NOT NULL PRIMARY KEY,
  "billId"         TEXT NOT NULL,
  "shipmentId"     TEXT,
  "trackingNumber" TEXT,
  "billedAmount"   BIGINT NOT NULL,
  "recordedAmount" BIGINT NOT NULL DEFAULT 0,
  "delta"          BIGINT NOT NULL DEFAULT 0,
  "note"           TEXT,
  CONSTRAINT "courier_bill_lines_billId_fkey" FOREIGN KEY ("billId") REFERENCES "courier_provider_bills"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "courier_bill_lines_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "courier_bill_lines_billId_idx" ON "courier_bill_lines" ("billId");
CREATE INDEX "courier_bill_lines_trackingNumber_idx" ON "courier_bill_lines" ("trackingNumber");

-- Refund ongkir (G247).
CREATE TABLE "shipping_cost_refunds" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "shipmentId"  TEXT NOT NULL,
  "orderId"     TEXT NOT NULL,
  "amount"      BIGINT NOT NULL,
  "reason"      TEXT NOT NULL,
  "status"      "ShippingRefundStatus" NOT NULL DEFAULT 'REQUESTED',
  "requestedBy" TEXT NOT NULL,
  "decidedBy"   TEXT,
  "decidedAt"   TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shipping_cost_refunds_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "shipping_cost_refunds_shipmentId_idx" ON "shipping_cost_refunds" ("shipmentId");
CREATE INDEX "shipping_cost_refunds_status_idx" ON "shipping_cost_refunds" ("status");

-- ============================================================
-- 3. SEED KATALOG (G227) — semua NONAKTIF (enabled=false).
-- ============================================================
INSERT INTO "courier_services"
  ("id", "providerCode", "serviceCode", "serviceName", "description", "enabled", "regions", "supportsPickup", "supportsDropoff", "slaGraceDays", "sortOrder")
VALUES
  ('seed-jne-reg',      'jne',      'REG',      'JNE Reguler',       'Layanan reguler JNE (mock katalog)',        false, '{*}', true,  true,  2, 10),
  ('seed-jne-yes',      'jne',      'YES',      'JNE YES',           'Yakin Esok Sampai (mock katalog)',          false, '{*}', true,  true,  1, 20),
  ('seed-jnt-ez',       'jnt',      'EZ',       'J&T Express EZ',    'Reguler J&T (mock katalog)',                false, '{*}', true,  true,  2, 10),
  ('seed-sicepat-reg',  'sicepat',  'REG',      'SiCepat Reguler',   'Reguler SiCepat (mock katalog)',            false, '{*}', true,  true,  2, 10),
  ('seed-sicepat-best', 'sicepat',  'BEST',     'SiCepat BEST',      'Besok Sampai Tujuan (mock katalog)',        false, '{*}', true,  true,  1, 20),
  ('seed-gosend-sameday','gosend',  'SAME_DAY', 'GoSend SameDay',    'Sameday Jabodetabek (mock katalog)',        false, '{ID-JKT,ID-BDG}', true, false, 1, 10),
  ('seed-gosend-instant','gosend',  'INSTANT',  'GoSend Instant',    'Instan 3 jam (mock katalog)',               false, '{ID-JKT}', true, false, 0, 20),
  ('seed-anteraja-reg', 'anteraja', 'REG',      'AnterAja Reguler',  'Reguler AnterAja (mock katalog)',           false, '{*}', true,  true,  2, 10),
  ('seed-paxel-big',    'paxel',    'BIG',      'Paxel Big',         'Samday Paxel (mock katalog)',               false, '{*}', true,  true,  1, 10),
  ('seed-mock-std',     'mock',     'STD',      'Mock Standard',     'Provider mock deterministik (sandbox/test)',false, '{*}', true,  true,  2, 99)
ON CONFLICT ("providerCode", "serviceCode") DO NOTHING;

-- Flag global per provider (G249) — default nonaktif.
INSERT INTO "courier_region_flags" ("id", "providerCode", "region", "enabled", "note")
VALUES
  ('flag-jne',      'jne',      '*', false, 'Flag global JNE'),
  ('flag-jnt',      'jnt',      '*', false, 'Flag global J&T Express'),
  ('flag-sicepat',  'sicepat',  '*', false, 'Flag global SiCepat'),
  ('flag-gosend',   'gosend',   '*', false, 'Flag global GoSend'),
  ('flag-anteraja', 'anteraja', '*', false, 'Flag global AnterAja'),
  ('flag-paxel',    'paxel',    '*', false, 'Flag global Paxel'),
  ('flag-mock',     'mock',     '*', false, 'Flag global Mock (sandbox/test)')
ON CONFLICT ("providerCode", "region") DO NOTHING;
