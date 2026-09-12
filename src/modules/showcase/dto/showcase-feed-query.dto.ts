import { IsOptional, IsString, IsIn, IsInt, Min, Max, MaxLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  SHOWCASE_CATEGORY_MAX_LENGTH,
  SHOWCASE_FEED_DEFAULT_LIMIT,
  SHOWCASE_FEED_MAX_LIMIT,
  SHOWCASE_SEARCH_MAX_LENGTH,
} from '../../../common/constants/app.constants';

/** Opsi urutan feed discover. */
export const SHOWCASE_FEED_SORTS = ['latest', 'popular'] as const;
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
  @IsIn(SHOWCASE_FEED_SORTS as unknown as string[], { message: 'sort must be one of: latest, popular' })
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
}
