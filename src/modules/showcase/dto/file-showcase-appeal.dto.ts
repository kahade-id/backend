import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * G404 — banding oleh pemilik item atas takedown/pembatasan moderasi.
 *
 * Alasan (min. 20 karakter) + bukti baru WAJIB. Bukti baru bisa berupa
 * object (mis. { fotoPerbaikan: [...], dokumen: [...] }) atau array —
 * yang penting tidak kosong.
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
      'Bukti baru yang mendukung banding (wajib, tidak boleh kosong). ' +
      'Contoh: { "fotoPerbaikan": ["https://..."], "keterangan": "..." }.',
  })
  @IsNotEmpty({ message: 'Bukti baru wajib dilampirkan saat mengajukan banding' })
  newEvidence!: Record<string, unknown> | unknown[];
}
