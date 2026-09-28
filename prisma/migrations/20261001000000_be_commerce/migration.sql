-- BE-COMMERCE batch (2026-10-01) — TIM BE-COMMERCE mega-batch Kahade.
-- ADDITIVE-ONLY: hanya CREATE TYPE, CREATE TABLE, dan ADD COLUMN (nullable /
-- ber-default). Tidak ada ALTER/DROP kolom existing, tidak ada perubahan
-- nilai enum existing. Aman untuk data produksi.

-- ── Enum baru ──────────────────────────────────────────────────────────────
CREATE TYPE "ProductType" AS ENUM ('JASA', 'FISIK', 'DIGITAL', 'LAINNYA');
CREATE TYPE "AddressLabel" AS ENUM ('RUMAH', 'KANTOR', 'LAINNYA');
CREATE TYPE "SlotBookingStatus" AS ENUM ('BOOKED', 'CANCELLED', 'COMPLETED');
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'WAITING_COUNTERPART', 'AGREED', 'CANCELLED');
CREATE TYPE "DigitalAssetType" AS ENUM ('FILE', 'LINK', 'LICENSE');
CREATE TYPE "JastipTripStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "JastipParticipantStatus" AS ENUM ('JOINED', 'PRICE_LOCKED', 'PAID', 'REFUNDED', 'REFUND_REQUIRED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "PatunganMode" AS ENUM ('BAGI_RATA', 'CUSTOM');
CREATE TYPE "PatunganStatus" AS ENUM ('OPEN', 'TARGET_REACHED', 'CONTEST', 'RELEASED', 'FAILED', 'REFUNDED');
CREATE TYPE "PatunganParticipantStatus" AS ENUM ('PENDING', 'PAID', 'REFUNDED', 'REFUND_REQUIRED', 'RELEASED');

-- ── Kolom baru di tabel existing (semua nullable / ber-default) ─────────────
ALTER TABLE "user_showcases" ADD COLUMN "productType" "ProductType";
ALTER TABLE "user_showcases" ADD COLUMN "scheduledAt" TIMESTAMPTZ(3);
ALTER TABLE "user_showcases" ADD COLUMN "originalPrice" BIGINT;
ALTER TABLE "user_showcases" ADD COLUMN "serviceDeadlineDays" INTEGER;
ALTER TABLE "user_showcases" ADD COLUMN "digitalDeliveryInfo" TEXT;
ALTER TABLE "user_showcases" ADD COLUMN "clickCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "user_showcases" ADD COLUMN "purchaseCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "user_showcases_scheduledAt_idx" ON "user_showcases"("scheduledAt") WHERE "scheduledAt" IS NOT NULL;

ALTER TABLE "products" ADD COLUMN "productType" "ProductType";
ALTER TABLE "products" ADD COLUMN "originalPriceSen" BIGINT;
ALTER TABLE "products" ADD COLUMN "serviceDeadlineDays" INTEGER;

ALTER TABLE "vouchers" ADD COLUMN "sellerId" TEXT;
CREATE INDEX "vouchers_sellerId_isActive_idx" ON "vouchers"("sellerId", "isActive");

-- ── Tabel baru ─────────────────────────────────────────────────────────────
CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" "AddressLabel" NOT NULL DEFAULT 'RUMAH',
    "customLabel" VARCHAR(40),
    "recipientName" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "addressLine" VARCHAR(300) NOT NULL,
    "city" VARCHAR(100) NOT NULL,
    "province" VARCHAR(100),
    "postalCode" VARCHAR(10) NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "addresses_userId_deletedAt_idx" ON "addresses"("userId", "deletedAt");

CREATE TABLE "search_keywords" (
    "keyword" VARCHAR(80) NOT NULL,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "lastSearchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "search_keywords_pkey" PRIMARY KEY ("keyword")
);

CREATE TABLE "service_slots" (
    "id" TEXT NOT NULL,
    "showcaseId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "slotDate" DATE NOT NULL,
    "startTime" VARCHAR(5) NOT NULL,
    "endTime" VARCHAR(5) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "bookedCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "service_slots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "service_slots_showcaseId_slotDate_isActive_idx" ON "service_slots"("showcaseId", "slotDate", "isActive");
CREATE INDEX "service_slots_sellerId_slotDate_idx" ON "service_slots"("sellerId", "slotDate");

CREATE TABLE "service_slot_bookings" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "status" "SlotBookingStatus" NOT NULL DEFAULT 'BOOKED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "service_slot_bookings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "service_slot_bookings_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "service_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "service_slot_bookings_slotId_userId_key" ON "service_slot_bookings"("slotId", "userId");
CREATE INDEX "service_slot_bookings_userId_status_idx" ON "service_slot_bookings"("userId", "status");

CREATE TABLE "order_agreements" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "sellerAgreedAt" TIMESTAMPTZ(3),
    "buyerAgreedAt" TIMESTAMPTZ(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "order_agreements_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_agreements_orderId_key" ON "order_agreements"("orderId");
CREATE INDEX "order_agreements_createdBy_idx" ON "order_agreements"("createdBy");

CREATE TABLE "digital_assets" (
    "id" TEXT NOT NULL,
    "showcaseId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "assetType" "DigitalAssetType" NOT NULL,
    "payload" TEXT NOT NULL,
    "label" VARCHAR(120),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "digital_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "digital_assets_showcaseId_deletedAt_sortOrder_idx" ON "digital_assets"("showcaseId", "deletedAt", "sortOrder");

CREATE TABLE "jastip_trips" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "orderDeadline" TIMESTAMPTZ(3) NOT NULL,
    "slotTotal" INTEGER NOT NULL DEFAULT 0,
    "slotUsed" INTEGER NOT NULL DEFAULT 0,
    "status" "JastipTripStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "jastip_trips_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "jastip_trips_hostId_status_idx" ON "jastip_trips"("hostId", "status");
CREATE INDEX "jastip_trips_status_orderDeadline_idx" ON "jastip_trips"("status", "orderDeadline");

CREATE TABLE "jastip_items" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "estimatedPrice" BIGINT,
    "note" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "jastip_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jastip_items_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "jastip_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "jastip_items_tripId_idx" ON "jastip_items"("tripId");

CREATE TABLE "jastip_participants" (
    "id" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "itemSummary" VARCHAR(300) NOT NULL,
    "goodsAmount" BIGINT,
    "jastipFee" BIGINT,
    "shippingCost" BIGINT,
    "totalLocked" BIGINT,
    "priceLockedAt" TIMESTAMPTZ(3),
    "orderId" TEXT,
    "status" "JastipParticipantStatus" NOT NULL DEFAULT 'JOINED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "jastip_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "jastip_participants_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "jastip_trips"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "jastip_participants_tripId_buyerId_key" ON "jastip_participants"("tripId", "buyerId");
CREATE INDEX "jastip_participants_buyerId_status_idx" ON "jastip_participants"("buyerId", "status");

CREATE TABLE "patungan_groups" (
    "id" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "targetAmount" BIGINT NOT NULL,
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "slotTotal" INTEGER NOT NULL DEFAULT 0,
    "mode" "PatunganMode" NOT NULL DEFAULT 'BAGI_RATA',
    "perPersonAmount" BIGINT,
    "status" "PatunganStatus" NOT NULL DEFAULT 'OPEN',
    "contestEndsAt" TIMESTAMPTZ(3),
    "releasedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "patungan_groups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "patungan_groups_hostId_status_idx" ON "patungan_groups"("hostId", "status");
CREATE INDEX "patungan_groups_status_deadlineAt_idx" ON "patungan_groups"("status", "deadlineAt");

CREATE TABLE "patungan_participants" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "orderId" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "status" "PatunganParticipantStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "patungan_participants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "patungan_participants_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "patungan_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "patungan_participants_groupId_userId_key" ON "patungan_participants"("groupId", "userId");
CREATE INDEX "patungan_participants_userId_status_idx" ON "patungan_participants"("userId", "status");

CREATE TABLE "banners" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "imageUrl" VARCHAR(500) NOT NULL,
    "linkUrl" VARCHAR(500),
    "position" VARCHAR(40) NOT NULL DEFAULT 'home_top',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMPTZ(3),
    "endsAt" TIMESTAMPTZ(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "banners_isActive_position_sortOrder_idx" ON "banners"("isActive", "position", "sortOrder");
