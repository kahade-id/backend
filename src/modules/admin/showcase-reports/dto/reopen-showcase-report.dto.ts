import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MODERATION_REASON_CODES } from '../moderation-prisma.types';
import {
  REOPEN_REASON_MIN_LENGTH,
  REOPEN_REASON_MAX_LENGTH,
} from '../moderation-lifecycle.constants';

/**
 * G401 — buka kembali laporan berstatus final.
 * Hanya SUPER_ADMIN (guard di controller). Alasan manual wajib (G422).
 */
export class ReopenShowcaseReportDto {
  @ApiProperty({
    description: `Alasan pembukaan kembali (wajib, min. ${REOPEN_REASON_MIN_LENGTH} karakter)`,
    minLength: REOPEN_REASON_MIN_LENGTH,
    maxLength: REOPEN_REASON_MAX_LENGTH,
  })
  @IsString()
  @MinLength(REOPEN_REASON_MIN_LENGTH)
  @MaxLength(REOPEN_REASON_MAX_LENGTH)
  reason!: string;

  @ApiPropertyOptional({
    description: 'Kode alasan moderasi terstandar (G412)',
    enum: [...MODERATION_REASON_CODES],
  })
  @IsOptional()
  @IsString()
  @IsIn([...MODERATION_REASON_CODES])
  reasonCode?: string;
}
