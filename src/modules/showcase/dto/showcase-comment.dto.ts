import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SHOWCASE_COMMENT_MAX_LENGTH } from '../../../common/constants/app.constants';

/**
 * Section 3 — komentar showcase.
 *
 * `parentId` membuat balasan bersarang. Kedalaman dibatasi satu tingkat di
 * service (balasan dari balasan ditolak) supaya UI tidak perlu merender tree
 * tak terbatas dan query-nya tetap bisa pakai index
 * (showcaseId, parentId, createdAt, id).
 */
export class CreateShowcaseCommentDto {
  @ApiProperty({ maxLength: SHOWCASE_COMMENT_MAX_LENGTH })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_COMMENT_MAX_LENGTH)
  content!: string;

  @ApiPropertyOptional({ description: 'ID komentar induk bila ini balasan.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string;
}

export class UpdateShowcaseCommentDto {
  @ApiProperty({ maxLength: SHOWCASE_COMMENT_MAX_LENGTH })
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(SHOWCASE_COMMENT_MAX_LENGTH)
  content!: string;
}

/**
 * Audit 2026-10-03 (BFE-117/FAL-009): toggle like/dislike komentar.
 * value: 1 = suka, -1 = tidak suka, 0 = hapus reaksi (idempoten per user).
 */
export class ToggleCommentLikeDto {
  @ApiProperty({ description: '1 = suka, -1 = tidak suka, 0 = hapus reaksi', enum: [1, -1, 0] })
  @IsIn([1, -1, 0], { message: 'value must be 1, -1, or 0' })
  value!: number;
}

/**
 * Audit 2026-10-03 (FAL-027): alasan hapus komentar (opsional).
 */
export class DeleteCommentDto {
  @ApiPropertyOptional({ description: 'Alasan penghapusan (opsional)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
