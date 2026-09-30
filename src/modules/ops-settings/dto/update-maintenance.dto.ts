import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMaintenanceDto {
  @ApiProperty({ description: 'true = aktifkan maintenance, false = matikan', example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description:
      'Pesan untuk user (maks 500 karakter). BAI-105: TIDAK DIKIRIM = pertahankan ' +
      'pesan lama; STRING KOSONG = hapus pesan kustom (kembali ke pesan default).',
    example: 'Aplikasi sedang upgrade ke versi baru. Kembali dalam ±30 menit.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @ApiPropertyOptional({
    description:
      'BAI-118: optimistic locking untuk toggle MAINTENANCE_MODE — versi yang ' +
      'ditampilkan saat admin memuat halaman. Bila versi DB sudah berubah, ' +
      'request ditolak 409.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
