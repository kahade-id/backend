-- Hapus total fitur katalog produk & persediaan (GAP-D G251–G275).
-- Keputusan user 2026-10-04: katalog dihapus seluruhnya (tidak ada data katalog).
-- Audit dependensi: OrderItem/productId hanya dibaca/ditulis modul inventory
-- sendiri (POST /v1/inventory/order-lines); modul orders/showcase tidak punya
-- konsep stok produk (hook stok di order-state/scheduler best-effort no-op
-- untuk order tanpa order lines). Kolom productId/variantId di-drop bersama
-- tabelnya. Enum ProductType DIPERTAHANKAN (dipakai UserShowcase).

DROP TABLE IF EXISTS "order_items" CASCADE;
DROP TABLE IF EXISTS "product_moderation_events" CASCADE;
DROP TABLE IF EXISTS "stock_movements" CASCADE;
DROP TABLE IF EXISTS "product_variants" CASCADE;
DROP TABLE IF EXISTS "stock_reservations" CASCADE;
DROP TABLE IF EXISTS "inventory_operations" CASCADE;
DROP TABLE IF EXISTS "products" CASCADE;

DROP TYPE IF EXISTS "ProductStatus";
DROP TYPE IF EXISTS "ProductModerationStatus";
DROP TYPE IF EXISTS "StockMovementType";
DROP TYPE IF EXISTS "StockMovementSource";
DROP TYPE IF EXISTS "StockActorRole";
DROP TYPE IF EXISTS "StockReservationStatus";
