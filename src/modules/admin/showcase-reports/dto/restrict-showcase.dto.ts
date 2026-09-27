import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { MODERATION_REASON_CODES } from '../moderation-prisma.types';
import {
  RESTRICT_MIN_DAYS,
  RESTRICT_MAX_DAYS,
  REOPEN_REASON_MIN_LENGTH,
  REOPEN_REASON_MAX_LENGTH,
} from '../moderation-lifecycle.constants';

/**
 * G423 — RESTRICT_TEMPORARY: sembunyikan item selama N hari (auto-restore via
 * scheduler). Berbeda dari TAKEDOWN permanen. Alasan manual wajib (G422).
 */
export class RestrictShowcaseDto {
  @ApiProperty({
    description: `Durasi penyembunyian dalam hari (${RESTRICT_MIN_DAYS}–${RESTRICT_MAX_DAYS}); auto-restore setelahnya`,
    minimum: RESTRICT_MIN_DAYS,
    maximum: RESTRICT_MAX_DAYS,
  })
  @Type(() => Number)
  @IsInt()
  @Min(RESTRICT_MIN_DAYS)
  @Max(RESTRICT_MAX_DAYS)
  days!: number;

  @ApiProperty({
    description: 'Alasan pembatasan (wajib, manual)',
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
