import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * ADM-328 — bulk dismiss / bulk under_review untuk laporan PENDING.
 * Pola sama seperti bulk QA (G441/G442): maks 50/request, confirm wajib,
 * hasil parsial per item. Aksi destruktif (takedown) TIDAK boleh bulk —
 * fail-closed by design.
 */
export const BULK_REVIEW_ACTIONS = ['dismiss', 'under_review'] as const;

export type BulkReviewAction = (typeof BULK_REVIEW_ACTIONS)[number];

export class BulkReviewShowcaseReportsDto {
  @ApiProperty({ description: 'ID laporan (maks 50)', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  ids!: string[];

  @ApiProperty({ description: 'Aksi bulk (hanya dismiss / under_review)', enum: BULK_REVIEW_ACTIONS })
  @IsString()
  @IsIn(BULK_REVIEW_ACTIONS)
  action!: BulkReviewAction;

  @ApiPropertyOptional({ description: 'Catatan resolusi untuk semua item' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;

  @ApiProperty({ description: 'Konfirmasi eksplisit wajib = true' })
  @IsBoolean()
  confirm!: boolean;
}
