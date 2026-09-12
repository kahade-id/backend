import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsEnum, IsInt,
  IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ShowcaseVisibility } from '@prisma/client';
import {
  SHOWCASE_CATEGORY_MAX_LENGTH,
  SHOWCASE_DESCRIPTION_MAX_LENGTH,
  SHOWCASE_MAX_IMAGES,
  SHOWCASE_TITLE_MAX_LENGTH,
} from '../../../common/constants/app.constants';

/**
 * Section 3 — showcase item.
 *
 * Perbedaan dari DTO lama (`users/dto/showcase.dto.ts`):
 *  - `imageUrl` (satu URL bebas) diganti `imageFileKeys` (object key hasil
 *    /upload/presigned-url + /upload/confirm dengan purpose SHOWCASE_IMAGE).
 *    URL tidak lagi diterima dari client supaya tidak ada hotlink/SSRF dan
 *    supaya setiap gambar bisa diverifikasi magic-byte + ukurannya di storage.
 *  - `visibility` (PUBLIC/PRIVATE) dan `category` ditambahkan.
 *  - Batas panjang disamakan dengan schema (`VarChar(100)` / `VarChar(500)`).
 *    DTO lama membolehkan 200/2000 yang akan ditolak Postgres sebagai 500.
 */
export class CreateShowcaseItemDto {
  @ApiProperty({ maxLength: SHOWCASE_TITLE_MAX_LENGTH })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({ maxLength: SHOWCASE_DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @ApiPropertyOptional({
    maxLength: SHOWCASE_CATEGORY_MAX_LENGTH,
    description: 'Kategori bebas untuk filter feed discover, mis. "ilustrasi".',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MaxLength(SHOWCASE_CATEGORY_MAX_LENGTH)
  category?: string;

  @ApiPropertyOptional({ enum: ShowcaseVisibility, default: ShowcaseVisibility.PUBLIC })
  @IsOptional()
  @IsEnum(ShowcaseVisibility)
  visibility?: ShowcaseVisibility;

  @ApiPropertyOptional({ minimum: 0, description: 'Harga minimum (Rupiah, bilangan bulat).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Harga maksimum (Rupiah, bilangan bulat).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMax?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Urutan tampil di etalase profil.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Object key hasil upload presigned (purpose SHOWCASE_IMAGE) yang sudah dikonfirmasi ' +
      'lewat POST /upload/confirm. Maksimum ' + String(SHOWCASE_MAX_IMAGES) + ' gambar.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHOWCASE_MAX_IMAGES)
  @ArrayUnique()
  @IsString({ each: true })
  imageFileKeys?: string[];
}

export class UpdateShowcaseItemDto {
  @ApiPropertyOptional({ maxLength: SHOWCASE_TITLE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({ maxLength: SHOWCASE_DESCRIPTION_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @ApiPropertyOptional({ maxLength: SHOWCASE_CATEGORY_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MaxLength(SHOWCASE_CATEGORY_MAX_LENGTH)
  category?: string;

  @ApiPropertyOptional({ enum: ShowcaseVisibility })
  @IsOptional()
  @IsEnum(ShowcaseVisibility)
  visibility?: ShowcaseVisibility;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMin?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMax?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    type: [String],
    description: 'Bila diisi, seluruh gambar diganti dengan daftar key ini.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SHOWCASE_MAX_IMAGES)
  @ArrayUnique()
  @IsString({ each: true })
  imageFileKeys?: string[];
}
