import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MODERATION_NOTE_MAX_LENGTH } from '../moderation-lifecycle.constants';

/**
 * G402 — tambah catatan moderasi (append; tidak menimpa resolution awal).
 */
export class AddModerationNoteDto {
  @ApiProperty({
    description: 'Catatan moderasi (append-only, tidak menimpa resolution awal)',
    maxLength: MODERATION_NOTE_MAX_LENGTH,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MODERATION_NOTE_MAX_LENGTH)
  note!: string;
}
