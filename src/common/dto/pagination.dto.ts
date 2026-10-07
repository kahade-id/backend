import { IsOptional, IsInt, IsString, MaxLength, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationDto {
  @ApiPropertyOptional({ description: 'Page number', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/**
 * 2026-10-07: Pagination + keyset cursor (NP-008).
 * Bug fix: endpoint yang memakai `@Query() PaginationDto` + `@Query('cursor')`
 * terpisah ditolak 422 "property cursor should not exist" karena
 * forbidNonWhitelisted. DTO ini menggabungkan keduanya.
 */
export class CursorPaginationDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Keyset cursor dari nextCursor respons sebelumnya' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  /**
   * Total baris — OPSIONAL sejak BD-008 (perf-fix 2026-09-29): endpoint yang
   * tidak menjalankan COUNT(*) tidak mengirim field ini. Konsumen (web/mobile)
   * memakai `hasNext`/`totalPages` untuk load-more, bukan angka total.
   */
  total?: number;
  page: number;
  limit: number;
  /**
   * Jumlah halaman — bila `total` diketahui: ceil(total/limit) seperti dulu.
   * Bila `total` tidak dikirim (tanpa COUNT): halaman yang TERKONFIRMASI ada,
   * yaitu `page + 1` saat `hasNext` true, `page` saat false. Bukan total
   * sebenarnya — cukup sebagai sinyal "masih ada halaman berikut".
   */
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export function createPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedResponse<T> {
  const totalPages = Math.ceil(total / limit);
  return {
    data,
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

/**
 * BD-008 (perf-fix 2026-09-29): potong hasil query `take: limit + 1` menjadi
 * satu halaman + flag `hasNext` yang eksak — pola yang sama dipakai feed
 * showcase (`showcase.service.ts`). Menggantikan `COUNT(*)` per halaman yang
 * memindai index range secara linear mengikuti pertumbuhan riwayat user.
 */
export function sliceLimitPlusOne<T>(fetched: T[], limit: number): { rows: T[]; hasNext: boolean } {
  const hasNext = fetched.length > limit;
  return { rows: hasNext ? fetched.slice(0, limit) : fetched, hasNext };
}

/**
 * BD-008: bangun `PaginatedResponse` tanpa `total` (tanpa COUNT).
 * `totalPages` = halaman terkonfirmasi (`page + 1` bila masih ada, `page`
 * bila tidak) — cukup untuk sinyal load-more di klien.
 */
export function createHasNextPaginatedResponse<T>(
  data: T[],
  page: number,
  limit: number,
  hasNext: boolean,
): PaginatedResponse<T> {
  return {
    data,
    page,
    limit,
    totalPages: hasNext ? page + 1 : page,
    hasNext,
    hasPrev: page > 1,
  };
}
