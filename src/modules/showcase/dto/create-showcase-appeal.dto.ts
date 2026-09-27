import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import {
  APPEAL_REASON_MIN_LENGTH,
  APPEAL_REASON_MAX_LENGTH,
} from '../../admin/showcase-reports/moderation-lifecycle.constants';

/**
 * G404 — pemilik item mengajukan banding atas takedown.
 * Alasan + bukti baru WAJIB (bukti = JSON berisi keys/files; mis.
 * { files: [...], note: ... }).
 */
export class CreateShowcaseAppealDto {
  @ApiProperty({
    description: `Alasan banding (wajib, min. ${APPEAL_REASON_MIN_LENGTH} karakter)`,
    minLength: APPEAL_REASON_MIN_LENGTH,
    maxLength: APPEAL_REASON_MAX_LENGTH,
  })
  @IsString()
  @MinLength(APPEAL_REASON_MIN_LENGTH)
  @MaxLength(APPEAL_REASON_MAX_LENGTH)
  reason!: string;

  @ApiProperty({
    description: 'Bukti baru (wajib): JSON berisi referensi file/keys, mis. { files: ["key1"], note: "..." }',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  newEvidence!: Record<string, unknown>;
}
