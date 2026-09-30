/**
 * GAP-D stok — DTO validasi (class-validator). Pesan user-facing Bahasa Indonesia.
 */
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  IsBoolean,
  Matches,
  ValidateNested,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SKU_PATTERN_MESSAGE } from '../inventory.constants';
import type { ProductStatus, StockMovementType } from '../inventory.types';

export const PRODUCT_STATUSES: ProductStatus[] = ['DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED'];
export const PRODUCT_STATUS_TRANSITIONS: Record<ProductStatus, ProductStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['OUT_OF_STOCK', 'ARCHIVED', 'DRAFT'],
  OUT_OF_STOCK: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};

const SKU_REGEX = /^[A-Z0-9][A-Z0-9._-]{2,47}$/;

export class ProductDimensionsDto {
  @IsOptional()
  @IsInt({ message: 'Berat harus bilangan bulat (gram).' })
  @Min(0, { message: 'Berat tidak boleh negatif.' })
  @Max(100000000, { message: 'Berat terlalu besar.' })
  weightGrams?: number;

  @IsOptional()
  lengthCm?: number;

  @IsOptional()
  widthCm?: number;

  @IsOptional()
  heightCm?: number;
}

export class CreateProductDto {
  @IsString({ message: 'SKU wajib berupa teks.' })
  @IsNotEmpty({ message: 'SKU wajib diisi.' })
  @MaxLength(48, { message: 'SKU maksimal 48 karakter.' })
  @Matches(SKU_REGEX, { message: SKU_PATTERN_MESSAGE })
  sku!: string;

  @IsString({ message: 'Nama produk wajib berupa teks.' })
  @IsNotEmpty({ message: 'Nama produk wajib diisi.' })
  @MaxLength(150, { message: 'Nama produk maksimal 150 karakter.' })
  name!: string;

  @IsOptional()
  @IsString({ message: 'Deskripsi wajib berupa teks.' })
  @MaxLength(5000, { message: 'Deskripsi maksimal 5000 karakter.' })
  description?: string;

  @IsString({ message: 'Kategori wajib berupa teks.' })
  @IsNotEmpty({ message: 'Kategori wajib diisi.' })
  @MaxLength(80, { message: 'Kategori maksimal 80 karakter.' })
  category!: string;

  /** Harga dalam rupiah (bukan sen) — dikonversi server ke sen. */
  @IsInt({ message: 'Harga harus bilangan bulat rupiah.' })
  @Min(0, { message: 'Harga tidak boleh negatif.' })
  priceRupiah!: number;

  @IsOptional()
  @IsInt({ message: 'Stok awal harus bilangan bulat.' })
  @Min(0, { message: 'Stok awal tidak boleh negatif.' })
  initialStock?: number;

  @IsOptional()
  @IsInt({ message: 'Ambang stok menipis harus bilangan bulat.' })
  @Min(0, { message: 'Ambang stok menipis tidak boleh negatif.' })
  lowStockThreshold?: number;

  @IsOptional()
  @IsBoolean({ message: 'requiresBusinessVerification harus boolean.' })
  requiresBusinessVerification?: boolean;

  @IsOptional()
  @IsObject({ message: 'Skema atribut harus berupa objek.' })
  attributesSchema?: Record<string, string[]>;

  @IsOptional()
  @IsObject({ message: 'Dimensi harus berupa objek.' })
  @ValidateNested()
  @Type(() => ProductDimensionsDto)
  dimensions?: ProductDimensionsDto;

  @IsOptional()
  @IsInt({ message: 'Berat harus bilangan bulat (gram).' })
  @Min(0)
  weightGrams?: number;

  @IsOptional()
  @IsArray({ message: 'Gambar harus berupa array fileKey.' })
  @ArrayMaxSize(10, { message: 'Maksimal 10 gambar per produk.' })
  @IsString({ each: true })
  imageFileKeys?: string[];
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MaxLength(150, { message: 'Nama produk maksimal 150 karakter.' })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000, { message: 'Deskripsi maksimal 5000 karakter.' })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80, { message: 'Kategori maksimal 80 karakter.' })
  category?: string;

  @IsOptional()
  @IsInt({ message: 'Harga harus bilangan bulat rupiah.' })
  @Min(0, { message: 'Harga tidak boleh negatif.' })
  priceRupiah?: number;

  @IsOptional()
  @IsInt({ message: 'Ambang stok menipis harus bilangan bulat.' })
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @IsBoolean()
  requiresBusinessVerification?: boolean;

  @IsOptional()
  @IsObject()
  attributesSchema?: Record<string, string[]>;

  @IsOptional()
  @IsInt({ message: 'Berat harus bilangan bulat (gram).' })
  @Min(0)
  weightGrams?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10, { message: 'Maksimal 10 gambar per produk.' })
  @IsString({ each: true })
  imageFileKeys?: string[];
}

export class UpdateProductStatusDto {
  @IsString()
  @IsIn(PRODUCT_STATUSES, { message: 'Status produk tidak valid.' })
  status!: ProductStatus;
}

export class CreateVariantDto {
  @IsString()
  @IsNotEmpty({ message: 'SKU varian wajib diisi.' })
  @MaxLength(48, { message: 'SKU varian maksimal 48 karakter.' })
  @Matches(SKU_REGEX, { message: SKU_PATTERN_MESSAGE })
  sku!: string;

  @IsObject({ message: 'Atribut varian harus berupa objek.' })
  attributes!: Record<string, string>;

  @IsOptional()
  @IsInt({ message: 'Harga varian harus bilangan bulat rupiah.' })
  @Min(0, { message: 'Harga varian tidak boleh negatif.' })
  priceRupiah?: number;

  @IsOptional()
  @IsInt({ message: 'Stok awal harus bilangan bulat.' })
  @Min(0, { message: 'Stok awal tidak boleh negatif.' })
  initialStock?: number;

  @IsOptional()
  @IsInt({ message: 'Ambang stok menipis harus bilangan bulat.' })
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @IsInt({ message: 'Berat harus bilangan bulat (gram).' })
  @Min(0)
  weightGrams?: number;
}

export class UpdateVariantDto {
  @IsOptional()
  @IsInt({ message: 'Harga varian harus bilangan bulat rupiah.' })
  @Min(0)
  priceRupiah?: number;

  @IsOptional()
  @IsInt({ message: 'Ambang stok menipis harus bilangan bulat.' })
  @Min(0)
  lowStockThreshold?: number;

  @IsOptional()
  @IsInt({ message: 'Berat harus bilangan bulat (gram).' })
  @Min(0)
  weightGrams?: number;
}

/** G267: adjustment manual — alasan WAJIB. */
export class AdjustStockDto {
  @IsString()
  @IsNotEmpty({ message: 'SKU wajib diisi.' })
  sku!: string;

  @IsInt({ message: 'Perubahan stok harus bilangan bulat (negatif = kurangi).' })
  delta!: number;

  @IsString({ message: 'Alasan wajib berupa teks.' })
  @IsNotEmpty({ message: 'Alasan penyesuaian stok wajib diisi.' })
  @MaxLength(500, { message: 'Alasan maksimal 500 karakter.' })
  reason!: string;
}

/** G259: lampirkan order lines (snapshot harga) ke sebuah order. */
export class OrderLineDto {
  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsString()
  @IsNotEmpty({ message: 'SKU baris order wajib diisi.' })
  sku!: string;

  @IsInt({ message: 'Jumlah harus bilangan bulat.' })
  @Min(1, { message: 'Jumlah minimal 1.' })
  qty!: number;
}

export class AttachOrderLinesDto {
  @IsString()
  @IsNotEmpty({ message: 'ID order wajib diisi.' })
  orderDbId!: string;

  @IsArray({ message: 'Baris order harus berupa array.' })
  @ArrayMaxSize(50, { message: 'Maksimal 50 baris per order.' })
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];
}

/** G274: validasi harga & stok terkini pre-checkout. */
export class PreCheckoutLineDto {
  @IsString()
  @IsNotEmpty({ message: 'SKU wajib diisi.' })
  sku!: string;

  @IsInt({ message: 'Jumlah harus bilangan bulat.' })
  @Min(1, { message: 'Jumlah minimal 1.' })
  qty!: number;
}

export class PreCheckoutDto {
  @IsArray({ message: 'Baris checkout harus berupa array.' })
  @ArrayMaxSize(50, { message: 'Maksimal 50 baris per checkout.' })
  @ValidateNested({ each: true })
  @Type(() => PreCheckoutLineDto)
  lines!: PreCheckoutLineDto[];
}

/** G265: bulk update harga/stok. */
export class BulkUpdateRowDto {
  @IsString()
  @IsNotEmpty({ message: 'SKU wajib diisi.' })
  sku!: string;

  @IsOptional()
  @IsInt({ message: 'Harga harus bilangan bulat rupiah.' })
  @Min(0, { message: 'Harga tidak boleh negatif.' })
  priceRupiah?: number;

  @IsOptional()
  @IsInt({ message: 'Stok harus bilangan bulat.' })
  @Min(0, { message: 'Stok tidak boleh negatif.' })
  setAvailable?: number;

  @IsOptional()
  @IsInt({ message: 'Ambang stok menipis harus bilangan bulat.' })
  @Min(0)
  lowStockThreshold?: number;
}

export class BulkUpdateDto {
  @IsArray({ message: 'Baris bulk harus berupa array.' })
  @ArrayMaxSize(500, { message: 'Maksimal 500 baris per bulk update.' })
  @ValidateNested({ each: true })
  @Type(() => BulkUpdateRowDto)
  rows!: BulkUpdateRowDto[];

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Alasan maksimal 500 karakter.' })
  reason?: string;
}

/** G272: keputusan moderasi admin. */
export class ModerateProductDto {
  @IsString()
  @IsIn(['APPROVED', 'REJECTED', 'FLAGGED'], { message: 'Keputusan moderasi tidak valid.' })
  decision!: 'APPROVED' | 'REJECTED' | 'FLAGGED';

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Catatan maksimal 1000 karakter.' })
  note?: string;
}

export class CatalogQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minPriceRupiah?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxPriceRupiah?: number;

  @IsOptional()
  @IsIn(['true', 'false'], { message: 'inStock harus true/false.' })
  inStock?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  verifiedBusinessOnly?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  requiresBusinessVerification?: string;

  @IsOptional()
  @IsString()
  sellerId?: string;

  @IsOptional()
  @IsIn(['newest', 'price_asc', 'price_desc', 'name'], { message: 'Urutkan tidak valid.' })
  sort?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class MovementQueryDto {
  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsIn(['RESERVE', 'RELEASE', 'DEDUCT', 'RESTOCK', 'ADJUST', 'RETURN'])
  type?: StockMovementType;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
