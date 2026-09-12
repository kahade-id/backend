import { IsOptional, IsString, MaxLength } from 'class-validator';
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
