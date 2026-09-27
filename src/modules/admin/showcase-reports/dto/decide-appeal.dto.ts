import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { APPEAL_DECISION_NOTE_MIN_LENGTH } from '../moderation-lifecycle.constants';

export const APPEAL_DECISIONS = ['APPROVED', 'REJECTED'] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];

/**
 * G405/G406/G407/G422 — putusan banding oleh reviewer.
 * decisionNote manual wajib; reviewer ≠ reviewedBy awal (guard 422 di service).
 */
export class DecideAppealDto {
  @ApiProperty({
    description: 'Putusan banding: APPROVED (item direstore) / REJECTED (keputusan dipertahankan)',
    enum: [...APPEAL_DECISIONS],
  })
  @IsString()
  @IsIn([...APPEAL_DECISIONS])
  decision!: AppealDecision;

  @ApiProperty({
    description: `Catatan putusan manual (wajib, min. ${APPEAL_DECISION_NOTE_MIN_LENGTH} karakter)`,
    minLength: APPEAL_DECISION_NOTE_MIN_LENGTH,
  })
  @IsString()
  @MinLength(APPEAL_DECISION_NOTE_MIN_LENGTH)
  @MaxLength(2000)
  decisionNote!: string;
}
