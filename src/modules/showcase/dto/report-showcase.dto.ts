import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO laporan terhadap item showcase (Etalase).
 *
 * `reason` wajib diisi (min 3, max 100 karakter) — ValidationPipe menolak
 * body kosong/terlalu panjang dengan 400 sebelum mencapai service.
 * `description` opsional, max 1000 karakter.
 */
export class ReportShowcaseDto {
  @ApiProperty({ description: 'Alasan pelaporan.', minLength: 3, maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3)
  @MaxLength(100)
  reason!: string;

  @ApiPropertyOptional({ description: 'Keterangan tambahan.', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(1000)
  description?: string;
}
