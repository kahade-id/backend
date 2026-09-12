import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ContentHiddenReason } from '@prisma/client';

/**
 * Section 4 — moderasi konten Q&A.
 *
 * `isHidden` polos digantikan alasan kategoris: menyembunyikan pertanyaan atau
 * komentar WAJIB menyebutkan kategorinya. Constraint DB
 * (profile_question_hidden_fields_consistent) menegakkan hal yang sama, jadi
 * tidak ada jalur yang bisa menyimpan isHidden=true tanpa alasan.
 */
export class HideContentDto {
  @ApiProperty({
    enum: ContentHiddenReason,
    description: 'Kategori alasan konten disembunyikan.',
  })
  @IsEnum(ContentHiddenReason, {
    message: 'reason must be one of: SPAM, INAPPROPRIATE, HARASSMENT, OTHER',
  })
  reason!: ContentHiddenReason;
}
