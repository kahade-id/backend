-- Migration: GAP-D stok — katalog produk & persediaan terstruktur (G251–G275).
-- Prinsip: append-only. Hanya CREATE TYPE / CREATE TABLE / CREATE INDEX /
-- CHECK constraint. TIDAK menyentuh tabel existing (orders, wallets,
-- showcase, users, ...). FK ke "orders"("id") dengan ON DELETE RESTRICT agar
-- riwayat order line tidak hilang saat order di-soft-delete.

-- 1. Enum baru.
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED');
CREATE TYPE "ProductModerationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'FLAGGED');
CREATE TYPE "StockMovementType" AS ENUM ('RESERVE', 'RELEASE', 'DEDUCT', 'RESTOCK', 'ADJUST', 'RETURN');
CREATE TYPE "StockMovementSource" AS ENUM ('ORDER', 'MANUAL', 'IMPORT', 'SYSTEM', 'ADMIN');
CREATE TYPE "StockActorRole" AS ENUM ('SELLER', 'ADMIN', 'SYSTEM');
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED');

-- 2. Entitas produk (G251) — terpisah dari showcase.
CREATE TABLE "products" (
  "id" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "businessProfileId" TEXT,
  "name" VARCHAR(150) NOT NULL,
  "description" TEXT,
  "category" VARCHAR(80) NOT NULL,
  "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
  "moderationStatus" "ProductModerationStatus" NOT NULL DEFAULT 'PENDING',
  "moderationNote" TEXT,
  "moderatedBy" TEXT,
  "moderatedAt" TIMESTAMPTZ(3),
  "requiresBusinessVerification" BOOLEAN NOT NULL DEFAULT false,
  "priceSen" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'IDR',
  "quantityAvailable" INTEGER NOT NULL DEFAULT 0,
  "quantityReserved" INTEGER NOT NULL DEFAULT 0,
  "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
  "weightGrams" INTEGER,
  "lengthCm" DECIMAL(8,2),
  "widthCm" DECIMAL(8,2),
  "heightCm" DECIMAL(8,2),
  "attributesSchema" JSONB,
  "imageFileKeys" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMPTZ(3),
  CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "products_quantityAvailable_nonneg" CHECK ("quantityAvailable" >= 0),
  CONSTRAINT "products_quantityReserved_nonneg" CHECK ("quantityReserved" >= 0),
  CONSTRAINT "products_priceSen_nonneg" CHECK ("priceSen" >= 0)
);
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");
CREATE INDEX "products_sellerId_status_idx" ON "products"("sellerId", "status");
CREATE INDEX "products_status_idx" ON "products"("status");
CREATE INDEX "products_category_status_idx" ON "products"("category", "status");
CREATE INDEX "products_sellerId_sku_idx" ON "products"("sellerId", "sku");

-- 3. Varian produk (G253).
CREATE TABLE "product_variants" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sku" TEXT NOT NULL,
  "attributes" JSONB NOT NULL,
  "priceSen" BIGINT,
  "quantityAvailable" INTEGER NOT NULL DEFAULT 0,
  "quantityReserved" INTEGER NOT NULL DEFAULT 0,
  "lowStockThreshold" INTEGER NOT NULL DEFAULT 0,
  "weightGrams" INTEGER,
  "imageFileKeys" TEXT[] NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_variants_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_variants_quantityAvailable_nonneg" CHECK ("quantityAvailable" >= 0),
  CONSTRAINT "product_variants_quantityReserved_nonneg" CHECK ("quantityReserved" >= 0)
);
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");
CREATE INDEX "product_variants_productId_idx" ON "product_variants"("productId");

-- 4. Order lines — snapshot qty & harga satuan (G259).
CREATE TABLE "order_items" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "variantId" TEXT,
  "sku" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "variantLabel" TEXT,
  "qty" INTEGER NOT NULL,
  "unitPriceSen" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "order_items_qty_positive" CHECK ("qty" > 0),
  CONSTRAINT "order_items_unitPriceSen_nonneg" CHECK ("unitPriceSen" >= 0)
);
CREATE INDEX "order_items_orderId_idx" ON "order_items"("orderId");
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");
CREATE INDEX "order_items_variantId_idx" ON "order_items"("variantId");

-- 5. Reservasi stok (G255) — idempoten per (orderId, sku).
CREATE TABLE "stock_reservations" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "productId" TEXT,
  "variantId" TEXT,
  "sku" TEXT NOT NULL,
  "qty" INTEGER NOT NULL,
  "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMPTZ(3),
  "releasedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_reservations_qty_positive" CHECK ("qty" > 0)
);
CREATE UNIQUE INDEX "stock_reservations_orderId_sku_key" ON "stock_reservations"("orderId", "sku");
CREATE INDEX "stock_reservations_orderId_status_idx" ON "stock_reservations"("orderId", "status");
CREATE INDEX "stock_reservations_status_expiresAt_idx" ON "stock_reservations"("status", "expiresAt");

-- 6. Riwayat mutasi stok beraudit (G266) — append-only.
CREATE TABLE "stock_movements" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "variantId" TEXT,
  "type" "StockMovementType" NOT NULL,
  "source" "StockMovementSource" NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" "StockActorRole" NOT NULL,
  "reason" TEXT,
  "ref" TEXT,
  "quantityChange" INTEGER NOT NULL,
  "beforeAvailable" INTEGER NOT NULL,
  "afterAvailable" INTEGER NOT NULL,
  "beforeReserved" INTEGER NOT NULL,
  "afterReserved" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stock_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "stock_movements_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "stock_movements_productId_createdAt_idx" ON "stock_movements"("productId", "createdAt");
CREATE INDEX "stock_movements_variantId_createdAt_idx" ON "stock_movements"("variantId", "createdAt");
CREATE INDEX "stock_movements_type_createdAt_idx" ON "stock_movements"("type", "createdAt");
CREATE INDEX "stock_movements_actorId_createdAt_idx" ON "stock_movements"("actorId", "createdAt");

-- 7. Idempotency operasi stok per order (G257).
CREATE TABLE "inventory_operations" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "op" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "actorId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_operations_idempotencyKey_key" ON "inventory_operations"("idempotencyKey");
CREATE INDEX "inventory_operations_orderId_idx" ON "inventory_operations"("orderId");

-- 8. Audit moderasi produk (G272) — append-only, terpisah dari moderasi showcase.
CREATE TABLE "product_moderation_events" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "fromStatus" "ProductModerationStatus",
  "toStatus" "ProductModerationStatus" NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" "StockActorRole" NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_moderation_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "product_moderation_events_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_moderation_events_productId_createdAt_idx" ON "product_moderation_events"("productId", "createdAt");
