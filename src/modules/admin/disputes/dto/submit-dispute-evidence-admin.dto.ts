import { IsString, IsNotEmpty, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { SubmitEvidenceDto } from '../../../disputes/dto/submit-evidence.dto';

/**
 * BAI-094 — submit bukti "titipan" admin.
 * SubmitEvidenceDto tidak punya `title` (DisputeEvidence juga tidak) — judul
 * dilipat ke baris pertama description, tapi API tetap meminta judul terpisah
 * agar UI admin bisa memisahkan kolom judul vs deskripsi.
 */
export class SubmitDisputeEvidenceAdminDto extends SubmitEvidenceDto {
  @ApiProperty({ description: 'Judul bukti (dilipat ke deskripsi)', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'Title must contain at least one non-whitespace character' })
  @MaxLength(200)
  title!: string;
}
