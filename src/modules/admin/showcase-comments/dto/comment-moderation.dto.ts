import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Audit 2026-10-03 (FAL-010): query daftar komentar untuk moderasi admin.
 */
export class CommentModerationListQueryDto {
  @ApiPropertyOptional({
    description: 'Filter status komentar',
    enum: ['all', 'visible', 'hidden', 'deleted'],
    default: 'all',
  })
  @IsOptional()
  @IsString()
  @IsIn(['all', 'visible', 'hidden', 'deleted'])
  status?: string;

  @ApiPropertyOptional({ description: 'Cari di isi komentar / username / nama author', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Halaman (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Jumlah per halaman (maks 100)', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * Audit 2026-10-03 (FAL-010): aksi moderasi komentar oleh admin.
 * - hide: sembunyikan (reason menentukan kategori: SPAM/INAPPROPRIATE/HARASSMENT/OTHER)
 * - unhide: tampilkan kembali
 * - delete: soft-delete (deletedAt/deletedBy/deleteReason)
 */
export class ModerateCommentDto {
  @ApiPropertyOptional({
    description: 'Aksi moderasi',
    enum: ['hide', 'unhide', 'delete'],
  })
  @IsString()
  @IsIn(['hide', 'unhide', 'delete'])
  action!: 'hide' | 'unhide' | 'delete';

  @ApiPropertyOptional({
    description: 'Alasan — kategori moderasi saat hide (SPAM/INAPPROPRIATE/HARASSMENT/OTHER); alasan bebas saat delete',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500)
  reason?: string;
}
