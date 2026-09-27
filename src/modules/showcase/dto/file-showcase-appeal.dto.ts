import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * G404 — banding oleh pemilik item atas takedown/pembatasan moderasi.
 *
 * Alasan (min. 20 karakter) + bukti baru WAJIB.
 *
 * SH-S-005: bukti berupa daftar FILE KEY yang terverifikasi (hasil upload
 * via alur /upload/direct + /upload/confirm dengan purpose report-evidence),
 * BUKAN JSON bebas. Backend memverifikasi via
 * `UploadService.verifyEvidenceFileKeys(..., 'report-evidence')` — key
 * asing/traversal/belum terkonfirmasi → 400, bukan tersimpan mentah.
 */
export class FileShowcaseAppealDto {
  @ApiProperty({
    description: 'Alasan banding (min. 20, maks. 2000 karakter).',
    minLength: 20,
    maxLength: 2000,
  })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(20)
  @MaxLength(2000)
  reason!: string;

  @ApiProperty({
    description:
      'Bukti baru (wajib, min. 1 file key): object key hasil /upload/direct + /upload/confirm ' +
      'dengan purpose report-evidence, mis. uploads/report-evidence/<userId>/<uuid>.jpg. ' +
      'Setiap key diverifikasi kepemilikan + konfirmasi oleh backend.',
    type: [String],
    minItems: 1,
    maxItems: 10,
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Bukti baru wajib dilampirkan saat mengajukan banding' })
  @ArrayMaxSize(10)
  @ArrayUnique({ message: 'Duplicate evidence file keys are not allowed' })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  evidenceFileKeys!: string[];
}
