/**
 * GAP-D stok — tipe domain (G251–G275).
 *
 * JEMBATAN SKEMA (penting): model/enum Prisma stok didefinisikan di
 * `prisma/schema-gap-d-stock.prisma` dan BELUM tergabung ke client yang
 * ter-generate. Sampai koordinator me-regenerate `@prisma/client` pasca-merge,
 * modul ini memakai union string lokal yang nilainya IDENTIK dengan enum
 * Prisma (sumber kebenaran = file skema gap-D). Setelah merge, ganti import
 * tipe di sini dengan `import { ProductStatus, ... } from '@prisma/client'`
 * dan hapus file ini — tidak ada perubahan logika yang dibutuhkan.
 */

export type ProductStatus = 'DRAFT' | 'ACTIVE' | 'OUT_OF_STOCK' | 'ARCHIVED';

export type ProductModerationStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'FLAGGED';

export type StockMovementType =
  | 'RESERVE'
  | 'RELEASE'
  | 'DEDUCT'
  | 'RESTOCK'
  | 'ADJUST'
  | 'RETURN';

export type StockMovementSource = 'ORDER' | 'MANUAL' | 'IMPORT' | 'SYSTEM' | 'ADMIN';

export type StockActorRole = 'SELLER' | 'ADMIN' | 'SYSTEM';

export type StockReservationStatus = 'ACTIVE' | 'RELEASED' | 'CONSUMED' | 'EXPIRED';

/** Status yang masih bisa dibeli dari katalog publik. */
export const PURCHASABLE_PRODUCT_STATUSES: ReadonlySet<ProductStatus> = new Set(['ACTIVE']);

/** Status terminal listing (tidak kembali ke ACTIVE tanpa aksi seller). */
export const TERMINAL_PRODUCT_STATUSES: ReadonlySet<ProductStatus> = new Set(['ARCHIVED']);

/** Bentuk baris products yang dipakai modul ini. */
export interface ProductRow {
  id: string;
  sku: string;
  sellerId: string;
  businessProfileId: string | null;
  name: string;
  description: string | null;
  category: string;
  status: ProductStatus;
  moderationStatus: ProductModerationStatus;
  moderationNote: string | null;
  moderatedBy: string | null;
  moderatedAt: Date | null;
  requiresBusinessVerification: boolean;
  priceSen: bigint;
  currency: string;
  quantityAvailable: number;
  quantityReserved: number;
  lowStockThreshold: number;
  weightGrams: number | null;
  lengthCm: unknown;
  widthCm: unknown;
  heightCm: unknown;
  attributesSchema: unknown;
  imageFileKeys: string[];
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/** Bentuk baris product_variants yang dipakai modul ini. */
export interface ProductVariantRow {
  id: string;
  productId: string;
  sku: string;
  attributes: Record<string, string>;
  priceSen: bigint | null;
  quantityAvailable: number;
  quantityReserved: number;
  lowStockThreshold: number;
  weightGrams: number | null;
  imageFileKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Bentuk baris order_items yang dipakai modul ini. */
export interface OrderItemRow {
  id: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  sku: string;
  productName: string;
  variantLabel: string | null;
  qty: number;
  unitPriceSen: bigint;
  createdAt: Date;
}

/** Bentuk baris stock_reservations yang dipakai modul ini. */
export interface StockReservationRow {
  id: string;
  orderId: string;
  productId: string | null;
  variantId: string | null;
  sku: string;
  qty: number;
  status: StockReservationStatus;
  expiresAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
}

/** Bentuk baris stock_movements yang dipakai modul ini. */
export interface StockMovementRow {
  id: string;
  productId: string;
  variantId: string | null;
  type: StockMovementType;
  source: StockMovementSource;
  actorId: string;
  actorRole: StockActorRole;
  reason: string | null;
  ref: string | null;
  quantityChange: number;
  beforeAvailable: number;
  afterAvailable: number;
  beforeReserved: number;
  afterReserved: number;
  createdAt: Date;
}

/** Delegate Prisma generik untuk satu model gap-D (mock-friendly). */
export interface InventoryModelDelegate {
  findUnique(args: unknown): Promise<unknown>;
  findFirst(args: unknown): Promise<unknown>;
  findMany(args: unknown): Promise<unknown[]>;
  create(args: unknown): Promise<unknown>;
  createMany(args: unknown): Promise<{ count: number }>;
  update(args: unknown): Promise<unknown>;
  updateMany(args: unknown): Promise<{ count: number }>;
  upsert(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<{ count: number }>;
  count(args: unknown): Promise<number>;
}

export interface InventoryDb {
  product: InventoryModelDelegate;
  productVariant: InventoryModelDelegate;
  orderItem: InventoryModelDelegate;
  stockReservation: InventoryModelDelegate;
  stockMovement: InventoryModelDelegate;
  inventoryOperation: InventoryModelDelegate;
  productModerationEvent: InventoryModelDelegate;
}

/** Satu baris order line untuk reservasi/decrement (G259). */
export interface InventoryOrderLine {
  productId: string | null;
  variantId: string | null;
  sku: string;
  productName: string;
  variantLabel: string | null;
  qty: number;
  unitPriceSen: bigint;
}

/** Hasil pre-checkout per baris (G274). */
export interface PreCheckoutLineResult {
  sku: string;
  found: boolean;
  purchasable: boolean;
  currentPriceSen: string | null; // string agar aman di JSON (BigInt)
  requestedQty: number;
  availableQty: number | null;
  sufficient: boolean;
  message: string;
}
