/**
 * GAP-D stok — logika inti katalog & persediaan (G251–G275).
 *
 * PRINSIP KEAMANAN UANG:
 * - Modul ini TIDAK PERNAH menyentuh wallet/escrow/payment. Hook dari
 *   order-state/scheduler memanggil safe* wrapper yang TIDAK PERNAH throw —
 *   kegagalan inventory tidak boleh merusak alur uang existing (G256).
 * - Setiap mutasi stok menulis baris StockMovement beraudit (G266).
 * - Anti-overselling (G258): reserve/decrement memakai conditional UPDATE
 *   di SQL (`... WHERE (available - reserved) >= qty`) dalam SATU $transaction.
 *   Tidak ada check-then-act di application layer.
 * - Idempotency per order (G257): InventoryOperation.idempotencyKey unik
 *   ("DEDUCT:<orderDbId>"); reserve idempoten via unique (orderId, sku).
 *
 * CATATAN SKEMA: model diakses via getInventoryDb() (inventory.db.ts) sampai
 * @prisma/client di-regenerate pasca-merge schema-gap-d-stock.prisma.
 */
import { Injectable, Logger, BadRequestException, ConflictException, NotFoundException, Optional } from '@nestjs/common';
import { BusinessVerificationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { getInventoryDb } from './inventory.db';
import { InventoryNotifyService } from './inventory-notify.service';
import {
  normalizeSku,
  isValidSku,
  SKU_PATTERN_MESSAGE,
  canonicalAttributeKey,
  validateVariantAttributes,
  variantLabelOf,
  CATALOG_DEFAULT_LIMIT,
  CATALOG_MAX_LIMIT,
  CSV_MAX_ROWS,
  CSV_MAX_BYTES,
  BULK_MAX_ROWS,
} from './inventory.constants';
import type {
  InventoryDb,
  InventoryOrderLine,
  OrderItemRow,
  PreCheckoutLineResult,
  ProductRow,
  ProductStatus,
  ProductVariantRow,
  StockActorRole,
  StockMovementSource,
  StockMovementType,
  StockReservationRow,
} from './inventory.types';
import type {
  AttachOrderLinesDto,
  BulkUpdateDto,
  CatalogQueryDto,
  CreateProductDto,
  CreateVariantDto,
  ModerateProductDto,
  MovementQueryDto,
  PreCheckoutDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/inventory.dto';
import { PRODUCT_STATUS_TRANSITIONS } from './dto/inventory.dto';

interface StockTarget {
  product: ProductRow;
  variant: ProductVariantRow | null;
  available: number;
  reserved: number;
  threshold: number;
  sku: string;
  name: string;
}

const PRE_CHECKOUT_POLICY =
  'Kebijakan checkout: harga yang tampil adalah harga terkini dari penjual dan ' +
  'dikunci saat Anda menekan Bayar. Stok bersifat terbatas dan dapat berubah ' +
  'selama Anda checkout; bila stok tidak mencukupi, order tidak dapat ' +
  'dilanjutkan dan dana tidak akan ditarik. Varian yang Anda pilih (ukuran/warna) ' +
  'dikunci pada ringkasan order.';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notify?: InventoryNotifyService,
  ) {}

  private db(): InventoryDb {
    return getInventoryDb(this.prisma);
  }

  // ------------------------------------------------------------------
  // G252: validasi & ketersediaan SKU
  // ------------------------------------------------------------------

  private assertSkuFormat(raw: string): string {
    const sku = normalizeSku(raw);
    if (!isValidSku(raw)) {
      throw new BadRequestException({ message: SKU_PATTERN_MESSAGE });
    }
    return sku;
  }

  /** SKU unik lintas tabel products & product_variants (G252). */
  async assertSkuAvailable(sku: string, excludeProductId?: string): Promise<void> {
    const db = this.db();
    const inProducts = await db.product.findFirst({
      where: { sku, ...(excludeProductId ? { id: { not: excludeProductId } } : {}) },
      select: { id: true },
    });
    if (inProducts) {
      throw new ConflictException({ message: `SKU "${sku}" sudah dipakai produk lain.` });
    }
    const inVariants = await db.productVariant.findFirst({
      where: { sku },
      select: { id: true },
    });
    if (inVariants) {
      throw new ConflictException({ message: `SKU "${sku}" sudah dipakai varian lain.` });
    }
  }

  private async getProductOrThrow(productId: string): Promise<ProductRow> {
    const product = (await this.db().product.findFirst({
      where: { id: productId, deletedAt: null },
    })) as ProductRow | null;
    if (!product) throw new NotFoundException({ message: 'Produk tidak ditemukan.' });
    return product;
  }

  private assertOwner(product: ProductRow, sellerId: string): void {
    if (product.sellerId !== sellerId) {
      throw new BadRequestException({ message: 'Anda bukan pemilik produk ini.' });
    }
  }

  // ------------------------------------------------------------------
  // Target stok (produk / varian) + operasi atomik
  // ------------------------------------------------------------------

  private async resolveTarget(
    db: InventoryDb,
    ref: { productId?: string | null; variantId?: string | null; sku: string },
  ): Promise<StockTarget> {
    let variant: ProductVariantRow | null = null;
    let product: ProductRow | null = null;
    if (ref.variantId) {
      variant = (await db.productVariant.findUnique({ where: { id: ref.variantId } })) as ProductVariantRow | null;
      if (!variant) throw new NotFoundException({ message: `Varian "${ref.sku}" tidak ditemukan.` });
      product = (await db.product.findFirst({
        where: { id: variant.productId, deletedAt: null },
      })) as ProductRow | null;
    } else if (ref.productId) {
      product = (await db.product.findFirst({
        where: { id: ref.productId, deletedAt: null },
      })) as ProductRow | null;
    } else {
      // Resolve by SKU (G270).
      product = (await db.product.findFirst({
        where: { sku: ref.sku, deletedAt: null },
      })) as ProductRow | null;
      if (!product) {
        variant = (await db.productVariant.findUnique({ where: { sku: ref.sku } })) as ProductVariantRow | null;
        if (variant) {
          product = (await db.product.findFirst({
            where: { id: variant.productId, deletedAt: null },
          })) as ProductRow | null;
        }
      }
    }
    if (!product) throw new NotFoundException({ message: `SKU "${ref.sku}" tidak ditemukan.` });
    const name = variant
      ? `${product.name} (${variantLabelOf(variant.attributes)})`
      : product.name;
    return {
      product,
      variant,
      available: variant ? variant.quantityAvailable : product.quantityAvailable,
      reserved: variant ? variant.quantityReserved : product.quantityReserved,
      threshold: variant ? variant.lowStockThreshold : product.lowStockThreshold,
      sku: variant ? variant.sku : product.sku,
      name,
    };
  }

  /**
   * Conditional UPDATE atomik (G258). Mengembalikan {available, reserved}
   * sesudah update, atau null bila kondisi tidak terpenuhi (stok kurang).
   */
  private async atomicAdjust(
    tx: unknown,
    target: StockTarget,
    opts: { reserveDelta?: number; availableDelta?: number },
  ): Promise<{ available: number; reserved: number } | null> {
    const raw = tx as {
      $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<
        Array<{ quantityAvailable: number; quantityReserved: number }>
      >;
    };
    // Nama tabel dipilih dari pasangan tetap internal (bukan input user) —
    // aman diinterpolasi; semua nilai memakai parameter $n (G258).
    const table = target.variant ? 'product_variants' : 'products';
    const id = target.variant ? target.variant.id : target.product.id;
    const rDelta = opts.reserveDelta ?? 0;
    const aDelta = opts.availableDelta ?? 0;
    // Guard sellable: reserve (+) atau pengurangan available (-) butuh
    // (available - reserved) >= kebutuhan — dicek ATOMIK di WHERE.
    const need = Math.max(rDelta, -aDelta);
    const sellableGuard = need > 0 ? `AND (s."quantityAvailable" - s."quantityReserved") >= $4` : '';
    const sql = `
      UPDATE "${table}" AS s
      SET "quantityReserved" = s."quantityReserved" + $1,
          "quantityAvailable" = s."quantityAvailable" + $2,
          "updatedAt" = NOW()
      WHERE s."id" = $3
        AND s."quantityAvailable" + $2 >= 0
        AND s."quantityReserved" + $1 >= 0
        AND s."quantityAvailable" + $2 >= s."quantityReserved" + $1
        ${sellableGuard}
      RETURNING s."quantityAvailable", s."quantityReserved"`;
    const params: unknown[] = need > 0 ? [rDelta, aDelta, id, need] : [rDelta, aDelta, id];
    const rows = await raw.$queryRawUnsafe(sql, ...params);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return { available: rows[0].quantityAvailable, reserved: rows[0].quantityReserved };
  }

  private async writeMovement(
    db: InventoryDb,
    m: {
      productId: string;
      variantId?: string | null;
      type: StockMovementType;
      source: StockMovementSource;
      actorId: string;
      actorRole: StockActorRole;
      reason?: string | null;
      ref?: string | null;
      quantityChange: number;
      beforeAvailable: number;
      afterAvailable: number;
      beforeReserved: number;
      afterReserved: number;
    },
  ): Promise<void> {
    await db.stockMovement.create({
      data: {
        productId: m.productId,
        variantId: m.variantId ?? null,
        type: m.type,
        source: m.source,
        actorId: m.actorId,
        actorRole: m.actorRole,
        reason: m.reason ?? null,
        ref: m.ref ?? null,
        quantityChange: m.quantityChange,
        beforeAvailable: m.beforeAvailable,
        afterAvailable: m.afterAvailable,
        beforeReserved: m.beforeReserved,
        afterReserved: m.afterReserved,
      },
    });
  }

  // ------------------------------------------------------------------
  // G251/G262: CRUD produk (seller)
  // ------------------------------------------------------------------

  async createProduct(sellerId: string, dto: CreateProductDto): Promise<ProductRow> {
    const sku = this.assertSkuFormat(dto.sku);
    await this.assertSkuAvailable(sku);
    const db = this.db();
    const initialStock = dto.initialStock ?? 0;
    const product = (await db.product.create({
      data: {
        sku,
        sellerId,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        category: dto.category.trim(),
        priceSen: BigInt(dto.priceRupiah) * 100n,
        quantityAvailable: initialStock,
        quantityReserved: 0,
        lowStockThreshold: dto.lowStockThreshold ?? 0,
        requiresBusinessVerification: dto.requiresBusinessVerification ?? false,
        attributesSchema: dto.attributesSchema ?? null,
        weightGrams: dto.weightGrams ?? dto.dimensions?.weightGrams ?? null,
        imageFileKeys: dto.imageFileKeys ?? [],
        status: 'DRAFT',
        moderationStatus: 'PENDING',
      },
    })) as ProductRow;
    if (initialStock > 0) {
      await this.writeMovement(db, {
        productId: product.id,
        type: 'RESTOCK',
        source: 'MANUAL',
        actorId: sellerId,
        actorRole: 'SELLER',
        reason: 'Stok awal produk',
        quantityChange: initialStock,
        beforeAvailable: 0,
        afterAvailable: initialStock,
        beforeReserved: 0,
        afterReserved: 0,
      });
    }
    return product;
  }

  async updateProduct(sellerId: string, productId: string, dto: UpdateProductDto): Promise<ProductRow> {
    const product = await this.getProductOrThrow(productId);
    this.assertOwner(product, sellerId);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description?.trim() || null;
    if (dto.category !== undefined) data.category = dto.category.trim();
    if (dto.priceRupiah !== undefined) data.priceSen = BigInt(dto.priceRupiah) * 100n;
    if (dto.lowStockThreshold !== undefined) data.lowStockThreshold = dto.lowStockThreshold;
    if (dto.requiresBusinessVerification !== undefined) data.requiresBusinessVerification = dto.requiresBusinessVerification;
    if (dto.attributesSchema !== undefined) data.attributesSchema = dto.attributesSchema;
    if (dto.weightGrams !== undefined) data.weightGrams = dto.weightGrams;
    if (dto.imageFileKeys !== undefined) data.imageFileKeys = dto.imageFileKeys;
    return (await this.db().product.update({ where: { id: productId }, data })) as ProductRow;
  }

  async setProductStatus(sellerId: string, productId: string, status: ProductStatus): Promise<ProductRow> {
    const product = await this.getProductOrThrow(productId);
    this.assertOwner(product, sellerId);
    const allowed = PRODUCT_STATUS_TRANSITIONS[product.status] ?? [];
    if (!allowed.includes(status) && product.status !== status) {
      throw new BadRequestException({
        message: `Transisi status ${product.status} → ${status} tidak diizinkan.`,
      });
    }
    return (await this.db().product.update({
      where: { id: productId },
      data: { status },
    })) as ProductRow;
  }

  async archiveProduct(sellerId: string, productId: string): Promise<ProductRow> {
    return this.setProductStatus(sellerId, productId, 'ARCHIVED');
  }

  // ------------------------------------------------------------------
  // G253: varian
  // ------------------------------------------------------------------

  async createVariant(sellerId: string, productId: string, dto: CreateVariantDto): Promise<ProductVariantRow> {
    const product = await this.getProductOrThrow(productId);
    this.assertOwner(product, sellerId);
    const sku = this.assertSkuFormat(dto.sku);
    await this.assertSkuAvailable(sku);
    const attrError = validateVariantAttributes(product.attributesSchema, dto.attributes);
    if (attrError) throw new BadRequestException({ message: attrError });
    const attributes = dto.attributes as Record<string, string>;
    const db = this.db();
    // Kombinasi unik per produk (G253).
    const existing = (await db.productVariant.findMany({
      where: { productId },
      select: { attributes: true },
    })) as Array<{ attributes: unknown }>;
    const newKey = canonicalAttributeKey(attributes);
    for (const row of existing) {
      if (canonicalAttributeKey(row.attributes as Record<string, string>) === newKey) {
        throw new ConflictException({ message: 'Kombinasi varian ini sudah ada untuk produk tersebut.' });
      }
    }
    const initialStock = dto.initialStock ?? 0;
    const variant = (await db.productVariant.create({
      data: {
        productId,
        sku,
        attributes,
        priceSen: dto.priceRupiah !== undefined ? BigInt(dto.priceRupiah) * 100n : null,
        quantityAvailable: initialStock,
        quantityReserved: 0,
        lowStockThreshold: dto.lowStockThreshold ?? 0,
        weightGrams: dto.weightGrams ?? null,
      },
    })) as ProductVariantRow;
    if (initialStock > 0) {
      await this.writeMovement(db, {
        productId,
        variantId: variant.id,
        type: 'RESTOCK',
        source: 'MANUAL',
        actorId: sellerId,
        actorRole: 'SELLER',
        reason: 'Stok awal varian',
        quantityChange: initialStock,
        beforeAvailable: 0,
        afterAvailable: initialStock,
        beforeReserved: 0,
        afterReserved: 0,
      });
    }
    return variant;
  }

  async updateVariant(sellerId: string, variantId: string, dto: UpdateVariantDto): Promise<ProductVariantRow> {
    const db = this.db();
    const variant = (await db.productVariant.findUnique({ where: { id: variantId } })) as ProductVariantRow | null;
    if (!variant) throw new NotFoundException({ message: 'Varian tidak ditemukan.' });
    const product = await this.getProductOrThrow(variant.productId);
    this.assertOwner(product, sellerId);
    const data: Record<string, unknown> = {};
    if (dto.priceRupiah !== undefined) data.priceSen = BigInt(dto.priceRupiah) * 100n;
    if (dto.lowStockThreshold !== undefined) data.lowStockThreshold = dto.lowStockThreshold;
    if (dto.weightGrams !== undefined) data.weightGrams = dto.weightGrams;
    return (await db.productVariant.update({ where: { id: variantId }, data })) as ProductVariantRow;
  }

  // ------------------------------------------------------------------
  // G260/G269/G270: katalog publik + daftar seller
  // ------------------------------------------------------------------

  private toCatalogItem(product: ProductRow & { variants?: ProductVariantRow[] }): Record<string, unknown> {
    const variants = product.variants ?? [];
    const sellable = variants.length > 0
      ? variants.reduce((s, v) => s + (v.quantityAvailable - v.quantityReserved), 0)
      : product.quantityAvailable - product.quantityReserved;
    return {
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      status: product.status,
      priceRupiah: Number(product.priceSen / 100n),
      sellable,
      lowStockThreshold: product.lowStockThreshold,
      requiresBusinessVerification: product.requiresBusinessVerification,
      imageFileKeys: product.imageFileKeys,
      // G269: tautan profil bisnis (seller).
      sellerId: product.sellerId,
      businessProfileId: product.businessProfileId,
      variants: variants.map(v => ({
        id: v.id,
        sku: v.sku,
        attributes: v.attributes,
        label: variantLabelOf(v.attributes),
        priceRupiah: v.priceSen != null ? Number((v.priceSen as bigint) / 100n) : null,
        sellable: v.quantityAvailable - v.quantityReserved,
      })),
    };
  }

  /** G260: katalog publik — hanya ACTIVE + moderasi APPROVED. */
  async listCatalog(query: CatalogQueryDto): Promise<{ items: unknown[]; page: number; limit: number; total: number }> {
    const db = this.db();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? CATALOG_DEFAULT_LIMIT, CATALOG_MAX_LIMIT);
    const where: Record<string, unknown> = {
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      deletedAt: null,
    };
    if (query.category) where.category = query.category;
    if (query.sellerId) where.sellerId = query.sellerId;
    // G271: filter produk yang butuh verifikasi bisnis.
    if (query.requiresBusinessVerification === 'true') where.requiresBusinessVerification = true;
    if (query.verifiedBusinessOnly === 'true') where.requiresBusinessVerification = true;
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { sku: { contains: normalizeSku(s), mode: 'insensitive' } },
      ];
    }
    if (query.minPriceRupiah !== undefined || query.maxPriceRupiah !== undefined) {
      const priceSen: Record<string, bigint> = {};
      if (query.minPriceRupiah !== undefined) priceSen.gte = BigInt(query.minPriceRupiah) * 100n;
      if (query.maxPriceRupiah !== undefined) priceSen.lte = BigInt(query.maxPriceRupiah) * 100n;
      where.priceSen = priceSen;
    }
    const orderBy: Record<string, string> =
      query.sort === 'price_asc' ? { priceSen: 'asc' }
      : query.sort === 'price_desc' ? { priceSen: 'desc' }
      : query.sort === 'name' ? { name: 'asc' }
      : { createdAt: 'desc' };
    const [rows, total] = await Promise.all([
      db.product.findMany({
        where,
        include: { variants: true },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }) as Promise<Array<ProductRow & { variants: ProductVariantRow[] }>>,
      db.product.count({ where }),
    ]);
    let items = rows.map(r => this.toCatalogItem(r));
    if (query.inStock === 'true') {
      items = items.filter(i => (i.sellable as number) > 0);
    } else if (query.inStock === 'false') {
      items = items.filter(i => (i.sellable as number) <= 0);
    }
    return { items, page, limit, total };
  }

  /** G270: daftar produk milik seller + pencarian SKU/nama varian. */
  async listSellerProducts(
    sellerId: string,
    query: { search?: string; status?: ProductStatus; page?: number; limit?: number },
  ): Promise<{ items: unknown[]; page: number; limit: number; total: number }> {
    const db = this.db();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? CATALOG_DEFAULT_LIMIT, CATALOG_MAX_LIMIT);
    const where: Record<string, unknown> = { sellerId, deletedAt: null };
    if (query.status) where.status = query.status;
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { sku: { contains: normalizeSku(s), mode: 'insensitive' } },
        // G270: cari juga lewat SKU varian.
        { variants: { some: { sku: { contains: normalizeSku(s), mode: 'insensitive' } } } },
      ];
    }
    const [rows, total] = await Promise.all([
      db.product.findMany({
        where,
        include: { variants: true },
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }) as Promise<Array<ProductRow & { variants: ProductVariantRow[] }>>,
      db.product.count({ where }),
    ]);
    return { items: rows.map(r => this.toCatalogItem(r)), page, limit, total };
  }

  async getProductDetail(productId: string, sellerId?: string): Promise<Record<string, unknown>> {
    const product = (await this.db().product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { variants: true },
    })) as (ProductRow & { variants: ProductVariantRow[] }) | null;
    if (!product) throw new NotFoundException({ message: 'Produk tidak ditemukan.' });
    const isOwner = sellerId !== undefined && product.sellerId === sellerId;
    if (!isOwner && (product.status !== 'ACTIVE' || product.moderationStatus !== 'APPROVED')) {
      throw new NotFoundException({ message: 'Produk tidak ditemukan.' });
    }
    const item = this.toCatalogItem(product);
    if (isOwner) {
      item.moderationStatus = product.moderationStatus;
      item.moderationNote = product.moderationNote;
      item.quantityAvailable = product.quantityAvailable;
      item.quantityReserved = product.quantityReserved;
    }
    return item;
  }

  // ------------------------------------------------------------------
  // G259: order lines (snapshot qty + harga satuan)
  // ------------------------------------------------------------------

  async attachOrderLines(orderDbId: string, dto: AttachOrderLinesDto): Promise<{ lines: OrderItemRow[]; created: boolean }> {
    const db = this.db();
    const existing = (await db.orderItem.findMany({ where: { orderId: orderDbId } })) as OrderItemRow[];
    if (existing.length > 0) return { lines: existing, created: false }; // idempoten
    const lines: InventoryOrderLine[] = [];
    for (const l of dto.lines) {
      const target = await this.resolveTarget(db, {
        productId: l.productId ?? null,
        variantId: l.variantId ?? null,
        sku: normalizeSku(l.sku),
      });
      if (target.product.status !== 'ACTIVE' || target.product.moderationStatus !== 'APPROVED') {
        throw new BadRequestException({
          message: `Produk "${target.product.name}" sedang tidak dapat dibeli.`,
        });
      }
      const unitPriceSen = target.variant?.priceSen ?? target.product.priceSen;
      lines.push({
        productId: target.product.id,
        variantId: target.variant ? target.variant.id : null,
        sku: target.sku,
        productName: target.product.name,
        variantLabel: target.variant ? variantLabelOf(target.variant.attributes) : null,
        qty: l.qty,
        unitPriceSen,
      });
    }
    const created = (await db.orderItem.createMany({
      data: lines.map(l => ({
        orderId: orderDbId,
        productId: l.productId,
        variantId: l.variantId,
        sku: l.sku,
        productName: l.productName,
        variantLabel: l.variantLabel,
        qty: l.qty,
        unitPriceSen: l.unitPriceSen,
      })),
    })) as { count: number };
    void created;
    const rows = (await db.orderItem.findMany({ where: { orderId: orderDbId } })) as OrderItemRow[];
    return { lines: rows, created: true };
  }

  private async getOrderLines(db: InventoryDb, orderDbId: string): Promise<OrderItemRow[]> {
    return (await db.orderItem.findMany({ where: { orderId: orderDbId } })) as OrderItemRow[];
  }

  // ------------------------------------------------------------------
  // G255/G258: reservasi atomik saat order menunggu pembayaran
  // ------------------------------------------------------------------

  /**
   * Cadangkan stok untuk order. Idempoten per order (unique (orderId, sku)
   * + inventory_operations "RESERVE:<orderDbId>").
   *
   * NOTE: dipanggil best-effort dari alur order (safeReserveForOrder) —
   * InsufficientStock TIDAK menggagalkan order; dicatat + seller diberi tahu.
   */
  async reserveForOrder(orderDbId: string, actorId = 'SYSTEM'): Promise<{ reserved: number; lines: number }> {
    const db = this.db();
    // Idempotency claim (G257).
    try {
      await db.inventoryOperation.create({
        data: { idempotencyKey: `RESERVE:${orderDbId}`, op: 'RESERVE', orderId: orderDbId, actorId },
      });
    } catch {
      return { reserved: 0, lines: 0 }; // sudah pernah diproses
    }
    const lines = await this.getOrderLines(db, orderDbId);
    if (lines.length === 0) {
      await db.inventoryOperation.deleteMany({ where: { idempotencyKey: `RESERVE:${orderDbId}` } }).catch(() => undefined);
      return { reserved: 0, lines: 0 };
    }
    await this.prisma.$transaction(async (tx: unknown) => {
      const tdb = getInventoryDb(tx as unknown as PrismaService);
      for (const line of lines) {
        const target = await this.resolveTarget(tdb, {
          productId: line.productId,
          variantId: line.variantId,
          sku: line.sku,
        });
        if (target.product.status !== 'ACTIVE' || target.product.moderationStatus !== 'APPROVED') {
          throw new ConflictException({
            code: 'PRODUCT_NOT_PURCHASABLE',
            message: `Produk "${target.product.name}" sedang tidak dapat dibeli.`,
          });
        }
        const before = { available: target.available, reserved: target.reserved };
        const after = await this.atomicAdjust(tx, target, { reserveDelta: line.qty });
        if (!after) {
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: `Stok "${target.name}" (${target.sku}) tidak mencukupi untuk ${line.qty} pcs.`,
          });
        }
        try {
          await tdb.stockReservation.create({
            data: {
              orderId: orderDbId,
              productId: target.product.id,
              variantId: target.variant ? target.variant.id : null,
              sku: target.sku,
              qty: line.qty,
              status: 'ACTIVE',
            },
          });
        } catch {
          // Duplikat (orderId, sku) — reserve ulang = no-op per baris.
        }
        await this.writeMovement(tdb, {
          productId: target.product.id,
          variantId: target.variant ? target.variant.id : null,
          type: 'RESERVE',
          source: 'ORDER',
          actorId,
          actorRole: 'SYSTEM',
          ref: orderDbId,
          quantityChange: 0,
          beforeAvailable: before.available,
          afterAvailable: after.available,
          beforeReserved: before.reserved,
          afterReserved: after.reserved,
        });
      }
    });
    return { reserved: lines.reduce((s, l) => s + l.qty, 0), lines: lines.length };
  }

  // ------------------------------------------------------------------
  // G256: pelepas reservasi (batal / kedaluwarsa / gagal bayar)
  // ------------------------------------------------------------------

  async releaseForOrder(orderDbId: string, reason: string, actorId = 'SYSTEM'): Promise<{ released: number }> {
    const db = this.db();
    const active = (await db.stockReservation.findMany({
      where: { orderId: orderDbId, status: 'ACTIVE' },
    })) as StockReservationRow[];
    if (active.length === 0) return { released: 0 }; // idempoten
    let released = 0;
    await this.prisma.$transaction(async (tx: unknown) => {
      const tdb = getInventoryDb(tx as unknown as PrismaService);
      for (const r of active) {
        const target = await this.resolveTarget(tdb, {
          productId: r.productId,
          variantId: r.variantId,
          sku: r.sku,
        });
        const before = { available: target.available, reserved: target.reserved };
        const after = await this.atomicAdjust(tx, target, { reserveDelta: -r.qty });
        if (!after) {
          // Seharusnya tidak terjadi (reserved >= qty karena reservasi aktif);
          // lewati baris ini agar pelepasan lain tetap jalan.
          this.logger.warn(`releaseForOrder: pelepasan ${r.sku} x${r.qty} gagal (inkonsisten) — dilewati.`);
          continue;
        }
        await tdb.stockReservation.update({
          where: { id: r.id },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
        await this.writeMovement(tdb, {
          productId: target.product.id,
          variantId: target.variant ? target.variant.id : null,
          type: 'RELEASE',
          source: 'ORDER',
          actorId,
          actorRole: 'SYSTEM',
          reason,
          ref: orderDbId,
          quantityChange: 0,
          beforeAvailable: before.available,
          afterAvailable: after.available,
          beforeReserved: before.reserved,
          afterReserved: after.reserved,
        });
        released += r.qty;
      }
    });
    return { released };
  }

  // ------------------------------------------------------------------
  // G257: pengurangan stok idempoten pasca-konfirmasi order
  // ------------------------------------------------------------------

  /**
   * Kurangi stok saat order selesai (COMPLETED). Idempoten via
   * InventoryOperation "DEDUCT:<orderDbId>" — panggil 2x = 1 eksekusi.
   */
  async decrementForOrder(orderDbId: string, actorId = 'SYSTEM'): Promise<{ deducted: number; alreadyDone: boolean }> {
    const db = this.db();
    try {
      await db.inventoryOperation.create({
        data: { idempotencyKey: `DEDUCT:${orderDbId}`, op: 'DEDUCT', orderId: orderDbId, actorId },
      });
    } catch {
      return { deducted: 0, alreadyDone: true };
    }
    const lines = await this.getOrderLines(db, orderDbId);
    if (lines.length === 0) return { deducted: 0, alreadyDone: false };
    const affected: Array<{ productId: string; sellerId: string; name: string; sku: string }> = [];
    await this.prisma.$transaction(async (tx: unknown) => {
      const tdb = getInventoryDb(tx as unknown as PrismaService);
      for (const line of lines) {
        const target = await this.resolveTarget(tdb, {
          productId: line.productId,
          variantId: line.variantId,
          sku: line.sku,
        });
        const before = { available: target.available, reserved: target.reserved };
        // Konsumsi reservasi aktif bila ada; jika tidak, kurangi langsung
        // dengan guard sellable (G258).
        const reservation = (await tdb.stockReservation.findFirst({
          where: { orderId: orderDbId, sku: target.sku, status: 'ACTIVE' },
        })) as StockReservationRow | null;
        const after = await this.atomicAdjust(tx, target, {
          reserveDelta: reservation ? -line.qty : 0,
          availableDelta: -line.qty,
        });
        if (!after) {
          throw new ConflictException({
            code: 'INSUFFICIENT_STOCK',
            message: `Stok "${target.name}" (${target.sku}) tidak mencukupi untuk pengurangan ${line.qty} pcs.`,
          });
        }
        if (reservation) {
          await tdb.stockReservation.update({
            where: { id: reservation.id },
            data: { status: 'CONSUMED', releasedAt: new Date() },
          });
        }
        await this.writeMovement(tdb, {
          productId: target.product.id,
          variantId: target.variant ? target.variant.id : null,
          type: 'DEDUCT',
          source: 'ORDER',
          actorId,
          actorRole: 'SYSTEM',
          ref: orderDbId,
          quantityChange: -line.qty,
          beforeAvailable: before.available,
          afterAvailable: after.available,
          beforeReserved: before.reserved,
          afterReserved: after.reserved,
        });
        affected.push({
          productId: target.product.id,
          sellerId: target.product.sellerId,
          name: target.name,
          sku: target.sku,
        });
      }
    });
    // G273: evaluasi peringatan stok di luar transaksi.
    for (const a of affected) {
      await this.evaluateStockAlerts(a.productId).catch(err =>
        this.logger.warn(`evaluateStockAlerts gagal: ${(err as Error).message}`),
      );
    }
    return { deducted: lines.reduce((s, l) => s + l.qty, 0), alreadyDone: false };
  }

  // ------------------------------------------------------------------
  // G267: adjustment manual (alasan wajib, kontrol role)
  // ------------------------------------------------------------------

  async adjustStock(params: {
    actorId: string;
    actorRole: 'SELLER' | 'ADMIN';
    sku: string;
    delta: number;
    reason: string;
  }): Promise<StockTarget & { available: number; reserved: number }> {
    if (!params.reason || params.reason.trim().length < 3) {
      throw new BadRequestException({ message: 'Alasan penyesuaian stok wajib diisi (minimal 3 karakter).' });
    }
    if (!Number.isInteger(params.delta) || params.delta === 0) {
      throw new BadRequestException({ message: 'Perubahan stok harus bilangan bulat tidak nol.' });
    }
    const sku = this.assertSkuFormat(params.sku);
    const db = this.db();
    const target = await this.resolveTarget(db, { sku });
    if (params.actorRole === 'SELLER') {
      this.assertOwner(target.product, params.actorId);
    }
    const before = { available: target.available, reserved: target.reserved };
    let after: { available: number; reserved: number } | null = null;
    await this.prisma.$transaction(async (tx: unknown) => {
      const tdb = getInventoryDb(tx as unknown as PrismaService);
      after = await this.atomicAdjust(tx, target, { availableDelta: params.delta });
      if (!after) {
        throw new BadRequestException({
          message:
            params.delta < 0
              ? 'Stok tidak mencukupi: stok tersedia tidak boleh kurang dari stok yang dicadangkan.'
              : 'Penyesuaian stok gagal.',
        });
      }
      await this.writeMovement(tdb, {
        productId: target.product.id,
        variantId: target.variant ? target.variant.id : null,
        type: 'ADJUST',
        source: params.actorRole === 'ADMIN' ? 'ADMIN' : 'MANUAL',
        actorId: params.actorId,
        actorRole: params.actorRole,
        reason: params.reason.trim(),
        quantityChange: params.delta,
        beforeAvailable: before.available,
        afterAvailable: (after as { available: number }).available,
        beforeReserved: before.reserved,
        afterReserved: (after as { reserved: number }).reserved,
      });
    });
    await this.evaluateStockAlerts(target.product.id).catch(err =>
      this.logger.warn(`evaluateStockAlerts gagal: ${(err as Error).message}`),
    );
    return { ...target, available: (after as unknown as { available: number }).available, reserved: (after as unknown as { reserved: number }).reserved };
  }

  // ------------------------------------------------------------------
  // G273: peringatan stok habis/menipis/pulih + status produk otomatis
  // ------------------------------------------------------------------

  private sellableOf(target: Pick<StockTarget, 'available' | 'reserved'>): number {
    return target.available - target.reserved;
  }

  /**
   * Evaluasi transisi stok per produk: habis / menipis / pulih.
   * Dipanggil pasca-decrement/adjust/restock (di luar transaksi uang).
   */
  async evaluateStockAlerts(productId: string): Promise<void> {
    const db = this.db();
    const product = (await db.product.findFirst({
      where: { id: productId, deletedAt: null },
      include: { variants: true },
    })) as (ProductRow & { variants: ProductVariantRow[] }) | null;
    if (!product || !this.notify) return;
    const units: Array<{ sku: string; name: string; sellable: number; threshold: number }> = [];
    if (product.variants.length > 0) {
      for (const v of product.variants) {
        units.push({
          sku: v.sku,
          name: `${product.name} (${variantLabelOf(v.attributes)})`,
          sellable: v.quantityAvailable - v.quantityReserved,
          threshold: v.lowStockThreshold,
        });
      }
    } else {
      units.push({
        sku: product.sku,
        name: product.name,
        sellable: product.quantityAvailable - product.quantityReserved,
        threshold: product.lowStockThreshold,
      });
    }
    const totalSellable = units.reduce((s, u) => s + u.sellable, 0);
    // Status produk otomatis ACTIVE ↔ OUT_OF_STOCK (G261). DRAFT/ARCHIVED
    // tidak disentuh.
    if (product.status === 'ACTIVE' && totalSellable <= 0) {
      await db.product.update({ where: { id: productId }, data: { status: 'OUT_OF_STOCK' } });
    } else if (product.status === 'OUT_OF_STOCK' && totalSellable > 0) {
      await db.product.update({ where: { id: productId }, data: { status: 'ACTIVE' } });
      await this.notify.notifyStockAlert({
        sellerId: product.sellerId,
        productId,
        productName: product.name,
        sku: product.sku,
        kind: 'RESTORED',
      });
    }
    for (const u of units) {
      if (u.sellable <= 0) {
        await this.notify.notifyStockAlert({
          sellerId: product.sellerId,
          productId,
          productName: u.name,
          sku: u.sku,
          kind: 'OUT',
        });
      } else if (u.threshold > 0 && u.sellable <= u.threshold) {
        await this.notify.notifyStockAlert({
          sellerId: product.sellerId,
          productId,
          productName: u.name,
          sku: u.sku,
          kind: 'LOW',
        });
      }
    }
  }

  // ------------------------------------------------------------------
  // G264: daftar stok menipis per SKU
  // ------------------------------------------------------------------

  async getLowStock(sellerId: string): Promise<Array<Record<string, unknown>>> {
    const db = this.db();
    const products = (await db.product.findMany({
      where: { sellerId, deletedAt: null, status: { in: ['ACTIVE', 'OUT_OF_STOCK'] } },
      include: { variants: true },
    })) as Array<ProductRow & { variants: ProductVariantRow[] }>;
    const out: Array<Record<string, unknown>> = [];
    for (const p of products) {
      if (p.variants.length > 0) {
        for (const v of p.variants) {
          const sellable = v.quantityAvailable - v.quantityReserved;
          if (v.lowStockThreshold > 0 && sellable <= v.lowStockThreshold) {
            out.push({
              productId: p.id,
              variantId: v.id,
              sku: v.sku,
              name: `${p.name} (${variantLabelOf(v.attributes)})`,
              sellable,
              threshold: v.lowStockThreshold,
              empty: sellable <= 0,
            });
          }
        }
      } else {
        const sellable = p.quantityAvailable - p.quantityReserved;
        if (p.lowStockThreshold > 0 && sellable <= p.lowStockThreshold) {
          out.push({
            productId: p.id,
            variantId: null,
            sku: p.sku,
            name: p.name,
            sellable,
            threshold: p.lowStockThreshold,
            empty: sellable <= 0,
          });
        }
      }
    }
    return out.sort((a, b) => (a.sellable as number) - (b.sellable as number));
  }

  // ------------------------------------------------------------------
  // G266: riwayat mutasi
  // ------------------------------------------------------------------

  async getMovements(
    viewer: { sellerId?: string; isAdmin: boolean },
    query: MovementQueryDto,
  ): Promise<{ items: unknown[]; page: number; limit: number; total: number }> {
    const db = this.db();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Record<string, unknown> = {};
    if (query.type) where.type = query.type;
    if (query.productId) {
      where.productId = query.productId;
    } else if (query.sku) {
      const sku = normalizeSku(query.sku);
      const product = (await db.product.findFirst({ where: { sku }, select: { id: true } })) as { id: string } | null;
      const variant = product
        ? null
        : ((await db.productVariant.findUnique({ where: { sku }, select: { id: true, productId: true } })) as {
            id: string;
            productId: string;
          } | null);
      if (product) where.productId = product.id;
      else if (variant) where.variantId = variant.id;
      else return { items: [], page, limit, total: 0 };
    }
    if (!viewer.isAdmin) {
      // Seller hanya melihat mutasi produk miliknya (G266/G267).
      const own = (await db.product.findMany({
        where: { sellerId: viewer.sellerId, deletedAt: null },
        select: { id: true },
      })) as Array<{ id: string }>;
      const ownIds = new Set(own.map(o => o.id));
      if (where.productId && !ownIds.has(where.productId as string)) {
        throw new BadRequestException({ message: 'Anda bukan pemilik produk ini.' });
      }
      where.productId = where.productId ?? { in: [...ownIds] };
    }
    const [rows, total] = await Promise.all([
      db.stockMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.stockMovement.count({ where }),
    ]);
    return { items: rows, page, limit, total };
  }

  // ------------------------------------------------------------------
  // G274: validasi server harga & stok terkini pre-checkout
  // ------------------------------------------------------------------

  async validatePreCheckout(dto: PreCheckoutDto): Promise<{
    lines: PreCheckoutLineResult[];
    allOk: boolean;
    policy: string;
  }> {
    const db = this.db();
    const lines: PreCheckoutLineResult[] = [];
    for (const l of dto.lines) {
      const sku = normalizeSku(l.sku);
      let target: StockTarget | null = null;
      try {
        target = await this.resolveTarget(db, { sku });
      } catch {
        target = null;
      }
      if (!target) {
        lines.push({
          sku, found: false, purchasable: false, currentPriceSen: null,
          requestedQty: l.qty, availableQty: null, sufficient: false,
          message: `SKU "${sku}" tidak ditemukan.`,
        });
        continue;
      }
      const purchasable =
        target.product.status === 'ACTIVE' &&
        target.product.moderationStatus === 'APPROVED' &&
        !target.product.deletedAt;
      const availableQty = this.sellableOf(target);
      const sufficient = purchasable && availableQty >= l.qty;
      const priceSen = target.variant?.priceSen ?? target.product.priceSen;
      lines.push({
        sku,
        found: true,
        purchasable,
        currentPriceSen: priceSen.toString(),
        requestedQty: l.qty,
        availableQty,
        sufficient,
        message: !purchasable
          ? `Produk "${target.name}" sedang tidak dapat dibeli.`
          : availableQty < l.qty
            ? `Stok "${target.name}" tersisa ${availableQty}, kurang dari ${l.qty} yang diminta.`
            : 'OK',
      });
    }
    return { lines, allOk: lines.every(l => l.sufficient), policy: PRE_CHECKOUT_POLICY };
  }

  // ------------------------------------------------------------------
  // G265: bulk update harga/stok dengan pratinjau dry-run
  // ------------------------------------------------------------------

  async bulkUpdate(
    sellerId: string,
    dto: BulkUpdateDto,
  ): Promise<{
    dryRun: boolean;
    preview: Array<Record<string, unknown>>;
    applied: number;
  }> {
    if (dto.rows.length === 0) throw new BadRequestException({ message: 'Tidak ada baris untuk diproses.' });
    if (dto.rows.length > BULK_MAX_ROWS) {
      throw new BadRequestException({ message: `Maksimal ${BULK_MAX_ROWS} baris per bulk update.` });
    }
    const db = this.db();
    const preview: Array<Record<string, unknown>> = [];
    const actionable: Array<{ target: StockTarget; row: (typeof dto.rows)[number] }> = [];
    for (const row of dto.rows) {
      const sku = this.assertSkuFormat(row.sku);
      let target: StockTarget | null = null;
      try {
        target = await this.resolveTarget(db, { sku });
      } catch {
        target = null;
      }
      if (!target) {
        preview.push({ sku, ok: false, error: `SKU "${sku}" tidak ditemukan.` });
        continue;
      }
      if (target.product.sellerId !== sellerId) {
        preview.push({ sku, ok: false, error: `SKU "${sku}" bukan milik Anda.` });
        continue;
      }
      const priceBeforeSen = target.variant?.priceSen ?? target.product.priceSen;
      const priceAfterSen = row.priceRupiah !== undefined ? BigInt(row.priceRupiah) * 100n : priceBeforeSen;
      if (row.setAvailable !== undefined && row.setAvailable < target.reserved) {
        preview.push({
          sku, ok: false,
          error: `Stok tidak boleh di bawah ${target.reserved} (dicadangkan) untuk SKU "${sku}".`,
        });
        continue;
      }
      preview.push({
        sku,
        name: target.name,
        ok: true,
        priceBeforeRupiah: Number(priceBeforeSen / 100n),
        priceAfterRupiah: Number(priceAfterSen / 100n),
        availableBefore: target.available,
        availableAfter: row.setAvailable ?? target.available,
        reserved: target.reserved,
      });
      actionable.push({ target, row });
    }
    const dryRun = dto.dryRun !== false;
    if (dryRun) return { dryRun: true, preview, applied: 0 };
    const reason = dto.reason?.trim() || 'Bulk update harga/stok';
    let applied = 0;
    await this.prisma.$transaction(async (tx: unknown) => {
      const tdb = getInventoryDb(tx as unknown as PrismaService);
      for (const { target, row } of actionable) {
        const priceSen = row.priceRupiah !== undefined ? BigInt(row.priceRupiah) * 100n : null;
        if (target.variant) {
          const data: Record<string, unknown> = {};
          if (priceSen !== null) data.priceSen = priceSen;
          if (row.lowStockThreshold !== undefined) data.lowStockThreshold = row.lowStockThreshold;
          if (row.setAvailable !== undefined) data.quantityAvailable = row.setAvailable;
          await tdb.productVariant.update({ where: { id: target.variant.id }, data });
        } else {
          const data: Record<string, unknown> = {};
          if (priceSen !== null) data.priceSen = priceSen;
          if (row.lowStockThreshold !== undefined) data.lowStockThreshold = row.lowStockThreshold;
          if (row.setAvailable !== undefined) data.quantityAvailable = row.setAvailable;
          await tdb.product.update({ where: { id: target.product.id }, data });
        }
        if (row.setAvailable !== undefined && row.setAvailable !== target.available) {
          await this.writeMovement(tdb, {
            productId: target.product.id,
            variantId: target.variant ? target.variant.id : null,
            type: 'ADJUST',
            source: 'MANUAL',
            actorId: sellerId,
            actorRole: 'SELLER',
            reason,
            ref: 'bulk-update',
            quantityChange: row.setAvailable - target.available,
            beforeAvailable: target.available,
            afterAvailable: row.setAvailable,
            beforeReserved: target.reserved,
            afterReserved: target.reserved,
          });
        }
        applied += 1;
      }
    });
    // Evaluasi peringatan stok untuk produk yang berubah.
    const productIds = new Set(actionable.map(a => a.target.product.id));
    for (const pid of productIds) {
      await this.evaluateStockAlerts(pid).catch(err =>
        this.logger.warn(`evaluateStockAlerts gagal: ${(err as Error).message}`),
      );
    }
    return { dryRun: false, preview, applied };
  }

  // ------------------------------------------------------------------
  // G263: impor/ekspor CSV dengan validasi per baris
  // ------------------------------------------------------------------

  private parseCsv(text: string): { header: string[]; rows: string[][] } {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) throw new BadRequestException({ message: 'File CSV kosong.' });
    const parseLine = (line: string): string[] => {
      const out: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
          if (c === '"') {
            if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
          } else cur += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map(s => s.trim());
    };
    const header = parseLine(lines[0]).map(h => h.toLowerCase());
    return { header, rows: lines.slice(1).map(parseLine) };
  }

  async importCsv(
    sellerId: string,
    csvText: string,
  ): Promise<{ created: number; updated: number; errors: Array<{ row: number; sku: string; errors: string[] }> }> {
    if (Buffer.byteLength(csvText, 'utf8') > CSV_MAX_BYTES) {
      throw new BadRequestException({ message: 'File CSV terlalu besar (maks 512 KB).' });
    }
    const { header, rows } = this.parseCsv(csvText);
    if (rows.length > CSV_MAX_ROWS) {
      throw new BadRequestException({ message: `Maksimal ${CSV_MAX_ROWS} baris per impor.` });
    }
    const required = ['sku', 'name', 'price_rupiah', 'available'];
    const missing = required.filter(c => !header.includes(c));
    if (missing.length > 0) {
      throw new BadRequestException({ message: `Kolom wajib hilang: ${missing.join(', ')}.` });
    }
    const idx = (c: string) => header.indexOf(c);
    const errors: Array<{ row: number; sku: string; errors: string[] }> = [];
    const valid: Array<{
      sku: string; name: string; category: string; priceRupiah: number;
      available: number; threshold: number; status: string | null;
    }> = [];
    const seen = new Set<string>();
    rows.forEach((cols, i) => {
      const rowNum = i + 2;
      const rowErrors: string[] = [];
      const rawSku = cols[idx('sku')] ?? '';
      const sku = normalizeSku(rawSku);
      if (!isValidSku(rawSku)) rowErrors.push(SKU_PATTERN_MESSAGE);
      if (seen.has(sku)) rowErrors.push(`SKU "${sku}" duplikat di file.`);
      seen.add(sku);
      const name = (cols[idx('name')] ?? '').trim();
      if (!name) rowErrors.push('Nama produk wajib diisi.');
      const priceRupiah = Number(cols[idx('price_rupiah')]);
      if (!Number.isInteger(priceRupiah) || priceRupiah < 0) rowErrors.push('price_rupiah harus bilangan bulat ≥ 0.');
      const available = Number(cols[idx('available')]);
      if (!Number.isInteger(available) || available < 0) rowErrors.push('available harus bilangan bulat ≥ 0.');
      const thresholdRaw = idx('low_stock_threshold') >= 0 ? cols[idx('low_stock_threshold')] : '';
      const threshold = thresholdRaw === '' ? 0 : Number(thresholdRaw);
      if (!Number.isInteger(threshold) || threshold < 0) rowErrors.push('low_stock_threshold harus bilangan bulat ≥ 0.');
      const statusRaw = (idx('status') >= 0 ? cols[idx('status')] : '').toUpperCase();
      if (statusRaw && !['DRAFT', 'ACTIVE'].includes(statusRaw)) rowErrors.push('status hanya boleh DRAFT/ACTIVE.');
      if (rowErrors.length > 0) {
        errors.push({ row: rowNum, sku: rawSku, errors: rowErrors });
        return;
      }
      valid.push({
        sku,
        name,
        category: idx('category') >= 0 && cols[idx('category')] ? cols[idx('category')].trim() : 'Lainnya',
        priceRupiah,
        available,
        threshold,
        status: statusRaw || null,
      });
    });
    // G263: bila ada baris invalid → 422 + laporan per baris, TIDAK ADA yang diterapkan.
    if (errors.length > 0) {
      throw new BadRequestException({
        code: 'CSV_ROW_ERRORS',
        message: `${errors.length} baris tidak valid. Perbaiki file lalu impor ulang.`,
        errors,
      });
    }
    let created = 0;
    let updated = 0;
    await this.prisma.$transaction(async (tx: unknown) => {
      const tdb = getInventoryDb(tx as unknown as PrismaService);
      for (const v of valid) {
        const existingProduct = (await tdb.product.findFirst({
          where: { sku: v.sku, deletedAt: null },
        })) as ProductRow | null;
        const existingVariant = existingProduct
          ? null
          : ((await tdb.productVariant.findUnique({ where: { sku: v.sku } })) as ProductVariantRow | null);
        if (existingProduct) {
          if (existingProduct.sellerId !== sellerId) {
            throw new BadRequestException({ message: `SKU "${v.sku}" milik seller lain.` });
          }
          if (v.available < existingProduct.quantityReserved) {
            throw new BadRequestException({
              message: `Stok SKU "${v.sku}" tidak boleh di bawah ${existingProduct.quantityReserved} (dicadangkan).`,
            });
          }
          const before = existingProduct.quantityAvailable;
          await tdb.product.update({
            where: { id: existingProduct.id },
            data: {
              name: v.name,
              category: v.category,
              priceSen: BigInt(v.priceRupiah) * 100n,
              quantityAvailable: v.available,
              lowStockThreshold: v.threshold,
              ...(v.status ? { status: v.status } : {}),
            },
          });
          if (v.available !== before) {
            await this.writeMovement(tdb, {
              productId: existingProduct.id,
              type: v.available > before ? 'RESTOCK' : 'ADJUST',
              source: 'IMPORT',
              actorId: sellerId,
              actorRole: 'SELLER',
              reason: 'Impor CSV',
              quantityChange: v.available - before,
              beforeAvailable: before,
              afterAvailable: v.available,
              beforeReserved: existingProduct.quantityReserved,
              afterReserved: existingProduct.quantityReserved,
            });
          }
          updated += 1;
        } else if (existingVariant) {
          const parent = (await tdb.product.findFirst({
            where: { id: existingVariant.productId, deletedAt: null },
          })) as ProductRow | null;
          if (!parent || parent.sellerId !== sellerId) {
            throw new BadRequestException({ message: `SKU "${v.sku}" milik seller lain.` });
          }
          if (v.available < existingVariant.quantityReserved) {
            throw new BadRequestException({
              message: `Stok SKU "${v.sku}" tidak boleh di bawah ${existingVariant.quantityReserved} (dicadangkan).`,
            });
          }
          const before = existingVariant.quantityAvailable;
          await tdb.productVariant.update({
            where: { id: existingVariant.id },
            data: {
              priceSen: BigInt(v.priceRupiah) * 100n,
              quantityAvailable: v.available,
              lowStockThreshold: v.threshold,
            },
          });
          if (v.available !== before) {
            await this.writeMovement(tdb, {
              productId: parent.id,
              variantId: existingVariant.id,
              type: v.available > before ? 'RESTOCK' : 'ADJUST',
              source: 'IMPORT',
              actorId: sellerId,
              actorRole: 'SELLER',
              reason: 'Impor CSV',
              quantityChange: v.available - before,
              beforeAvailable: before,
              afterAvailable: v.available,
              beforeReserved: existingVariant.quantityReserved,
              afterReserved: existingVariant.quantityReserved,
            });
          }
          updated += 1;
        } else {
          const createdProduct = (await tdb.product.create({
            data: {
              sku: v.sku,
              sellerId,
              name: v.name,
              category: v.category,
              priceSen: BigInt(v.priceRupiah) * 100n,
              quantityAvailable: v.available,
              quantityReserved: 0,
              lowStockThreshold: v.threshold,
              status: (v.status as ProductStatus) ?? 'DRAFT',
              moderationStatus: 'PENDING',
            },
          })) as ProductRow;
          if (v.available > 0) {
            await this.writeMovement(tdb, {
              productId: createdProduct.id,
              type: 'RESTOCK',
              source: 'IMPORT',
              actorId: sellerId,
              actorRole: 'SELLER',
              reason: 'Impor CSV',
              quantityChange: v.available,
              beforeAvailable: 0,
              afterAvailable: v.available,
              beforeReserved: 0,
              afterReserved: 0,
            });
          }
          created += 1;
        }
      }
    });
    return { created, updated, errors: [] };
  }

  async exportCsv(sellerId: string): Promise<string> {
    const db = this.db();
    const products = (await db.product.findMany({
      where: { sellerId, deletedAt: null },
      include: { variants: true },
      orderBy: { sku: 'asc' },
    })) as Array<ProductRow & { variants: ProductVariantRow[] }>;
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = ['sku,name,category,price_rupiah,available,reserved,low_stock_threshold,status'];
    for (const p of products) {
      lines.push(
        [p.sku, esc(p.name), esc(p.category), String(Number(p.priceSen / 100n)),
          String(p.quantityAvailable), String(p.quantityReserved),
          String(p.lowStockThreshold), p.status].join(','),
      );
      for (const v of p.variants) {
        lines.push(
          [v.sku, esc(`${p.name} (${variantLabelOf(v.attributes)})`), esc(p.category),
            String(v.priceSen != null ? Number((v.priceSen as bigint) / 100n) : Number(p.priceSen / 100n)),
            String(v.quantityAvailable), String(v.quantityReserved),
            String(v.lowStockThreshold), p.status].join(','),
        );
      }
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------
  // G271: cek verifikasi bisnis seller
  // ------------------------------------------------------------------

  async isSellerBusinessVerified(sellerId: string): Promise<boolean> {
    const row = await this.prisma.businessVerification.findFirst({
      where: { userId: sellerId, status: BusinessVerificationStatus.APPROVED },
      select: { id: true },
    });
    return !!row;
  }

  // ------------------------------------------------------------------
  // G272: moderasi produk (admin) — terpisah dari moderasi showcase
  // ------------------------------------------------------------------

  async moderateProduct(
    adminId: string,
    productId: string,
    dto: ModerateProductDto,
  ): Promise<ProductRow> {
    const product = await this.getProductOrThrow(productId);
    const fromStatus = product.moderationStatus;
    const updated = (await this.db().product.update({
      where: { id: productId },
      data: {
        moderationStatus: dto.decision,
        moderationNote: dto.note?.trim() || null,
        moderatedBy: adminId,
        moderatedAt: new Date(),
      },
    })) as ProductRow;
    await this.db().productModerationEvent.create({
      data: {
        productId,
        fromStatus,
        toStatus: dto.decision,
        actorId: adminId,
        actorRole: 'ADMIN',
        note: dto.note?.trim() || null,
      },
    });
    return updated;
  }

  async listProductsAdmin(query: {
    moderationStatus?: string;
    status?: ProductStatus;
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<{ items: unknown[]; page: number; limit: number; total: number }> {
    const db = this.db();
    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 20, 100);
    const where: Record<string, unknown> = { deletedAt: null };
    if (query.moderationStatus) where.moderationStatus = query.moderationStatus;
    if (query.status) where.status = query.status;
    if (query.search) {
      const s = query.search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { sku: { contains: normalizeSku(s), mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      db.product.findMany({
        where,
        include: { variants: { select: { id: true, sku: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      db.product.count({ where }),
    ]);
    return { items: rows, page, limit, total };
  }

  async getModerationEvents(productId: string): Promise<unknown[]> {
    await this.getProductOrThrow(productId);
    return this.db().productModerationEvent.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // ------------------------------------------------------------------
  // G256/G257 — hook aman untuk alur order (TIDAK PERNAH throw)
  // ------------------------------------------------------------------

  /**
   * Wrapper best-effort: kegagalan inventory TIDAK BOLEH merusak alur uang.
   * Dipanggil dari OrderStateService (post-commit) & scheduler kedaluwarsa.
   */
  async safeReserveForOrder(orderDbId: string): Promise<void> {
    try {
      await this.reserveForOrder(orderDbId);
    } catch (err) {
      this.logger.warn(
        `safeReserveForOrder ${orderDbId} gagal (order tetap jalan): ${(err as Error).message}`,
      );
    }
  }

  async safeReleaseForOrder(orderDbId: string, reason: string): Promise<void> {
    try {
      await this.releaseForOrder(orderDbId, reason);
    } catch (err) {
      this.logger.warn(
        `safeReleaseForOrder ${orderDbId} gagal: ${(err as Error).message}`,
      );
    }
  }

  async safeDecrementForOrder(orderDbId: string): Promise<void> {
    try {
      await this.decrementForOrder(orderDbId);
    } catch (err) {
      this.logger.warn(
        `safeDecrementForOrder ${orderDbId} gagal: ${(err as Error).message}`,
      );
    }
  }
}
