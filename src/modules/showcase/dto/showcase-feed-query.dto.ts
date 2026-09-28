import { IsOptional, IsString, IsIn, IsInt, IsNumber, IsEnum, Min, Max, MaxLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ShowcaseCondition, ProductType } from '@prisma/client';
import {
  SHOWCASE_CATEGORY_MAX_LENGTH,
  SHOWCASE_FEED_DEFAULT_LIMIT,
  SHOWCASE_FEED_MAX_LIMIT,
  SHOWCASE_SEARCH_MAX_LENGTH,
} from '../../../common/constants/app.constants';

/** Opsi urutan feed discover: terbaru, populer harian, atau personal (Untuk Anda). */
export const SHOWCASE_FEED_SORTS = ['latest', 'popular', 'foryou'] as const;
export type ShowcaseFeedSort = (typeof SHOWCASE_FEED_SORTS)[number];

/**
 * Section 3 — query feed discover.
 *
 * CURSOR-BASED, bukan offset. Offset pada feed yang isinya terus bertambah
 * menghasilkan duplikat/lompatan setiap kali ada item baru masuk (masalah yang
 * sudah diperbaiki di audit pagination sebelumnya). Cursor di sini berupa token
 * opaque berisi nilai kolom pengurutan baris terakhir, sehingga halaman berikutnya
 * selalu "setelah" baris itu walau ada item baru yang masuk di atasnya.
 */
export class ShowcaseFeedQueryDto {
  @ApiPropertyOptional({
    description:
      'Cursor opaque dari field `nextCursor` respons sebelumnya. Kosongkan untuk halaman pertama.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @ApiPropertyOptional({ default: SHOWCASE_FEED_DEFAULT_LIMIT, minimum: 1, maximum: SHOWCASE_FEED_MAX_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SHOWCASE_FEED_MAX_LIMIT)
  limit: number = SHOWCASE_FEED_DEFAULT_LIMIT;

  @ApiPropertyOptional({ enum: SHOWCASE_FEED_SORTS as unknown as string[], default: 'latest' })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsIn(SHOWCASE_FEED_SORTS as unknown as string[], { message: 'sort must be one of: latest, popular, foryou' })
  sort: ShowcaseFeedSort = 'latest';

  @ApiPropertyOptional({ maxLength: SHOWCASE_CATEGORY_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MaxLength(SHOWCASE_CATEGORY_MAX_LENGTH)
  category?: string;

  @ApiPropertyOptional({
    maxLength: SHOWCASE_SEARCH_MAX_LENGTH,
    description: 'Mencari di title, description, category, dan username penjual.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_SEARCH_MAX_LENGTH)
  search?: string;

  @ApiPropertyOptional({
    description:
      'Filter harga minimum (IDR). Item tanpa harga disembunyikan saat filter harga aktif. ' +
      'Cocok bila rentang harga item beririsan dengan [minPrice, maxPrice].',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999999999999)
  minPrice?: number;

  @ApiPropertyOptional({
    description: 'Filter harga maksimum (IDR). Lihat minPrice.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999999999999)
  maxPrice?: number;

  @ApiPropertyOptional({
    maxLength: SHOWCASE_SEARCH_MAX_LENGTH,
    description:
      'Filter lokasi: hanya item yang pemiliknya punya free-text alamat ' +
      '(users.address) yang cocok case-insensitive dengan nilai ini. ' +
      'Contoh: "Jakarta", "Bandung". Kosongkan untuk menonaktifkan.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_SEARCH_MAX_LENGTH)
  location?: string;

  @ApiPropertyOptional({
    enum: ['baru', 'bekas'],
    description:
      'Filter kondisi barang (batch 19 TIM A, item 6). Enum: BARU = barang baru, ' +
      'BEKAS = barang bekas/second. Item tanpa kondisi disembunyikan saat filter aktif.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(ShowcaseCondition, { message: 'condition must be one of: baru, bekas' })
  condition?: ShowcaseCondition;

  @ApiPropertyOptional({
    description:
      'Filter rating penjual (batch 19 TIM A, item 6): hanya item yang averageRating ' +
      'pemilik >= nilai ini (0–5, desimal boleh). Pemilik tanpa rating dianggap ' +
      'tidak lolos kecuali nilai 0.',
    minimum: 0,
    maximum: 5,
    example: 4.0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  minSellerRating?: number;

  @ApiPropertyOptional({
    enum: ['JASA', 'FISIK', 'DIGITAL', 'LAINNYA'],
    description:
      'Filter tipe produk (batch 139 BE-API2, item 121): JASA = jasa/layanan, ' +
      'FISIK = barang fisik, DIGITAL = produk digital, LAINNYA = lainnya. ' +
      'Case-insensitive (dinormalisasi ke uppercase).',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(ProductType, { message: 'productType must be one of: JASA, FISIK, DIGITAL, LAINNYA' })
  productType?: ProductType;
}
