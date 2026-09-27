import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  SHOWCASE_HIGHLIGHT_MAX_PRODUCTS,
  SHOWCASE_HIGHLIGHT_TITLE_MAX_LENGTH,
} from '../../../../common/constants/app.constants';

/**
 * Batch 19 TIM A (item 4) — highlight etalase: koleksi pilihan berisi
 * produk-produk etalase milik user, dengan cover opsional.
 */
export class CreateHighlightDto {
  @ApiProperty({ maxLength: SHOWCASE_HIGHLIGHT_TITLE_MAX_LENGTH, example: 'Koleksi Lebaran' })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(SHOWCASE_HIGHLIGHT_TITLE_MAX_LENGTH)
  title!: string;

  @ApiPropertyOptional({
    description:
      'Id media (ShowcaseImage.id) milik salah satu etalase milikmu — dijadikan cover. ' +
      'Kosongkan untuk memakai media pertama produk pertama sebagai cover.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coverMediaId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Id etalase MILIKMU yang masuk highlight (unik, maks ' + SHOWCASE_HIGHLIGHT_MAX_PRODUCTS + ').',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(SHOWCASE_HIGHLIGHT_MAX_PRODUCTS)
  @IsString({ each: true })
  productIds?: string[];
}

export class UpdateHighlightDto {
  @ApiPropertyOptional({ maxLength: SHOWCASE_HIGHLIGHT_TITLE_MAX_LENGTH })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(SHOWCASE_HIGHLIGHT_TITLE_MAX_LENGTH)
  title?: string;

  @ApiPropertyOptional({
    description: 'Ganti cover. Kirim null untuk menghapus cover (kembali ke fallback otomatis).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  coverMediaId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'REPLACE penuh daftar produk bila diisi.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(SHOWCASE_HIGHLIGHT_MAX_PRODUCTS)
  @IsString({ each: true })
  productIds?: string[];
}
