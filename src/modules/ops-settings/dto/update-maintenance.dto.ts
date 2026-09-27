import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateMaintenanceDto {
  @ApiProperty({ description: 'true = aktifkan maintenance, false = matikan', example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    description: 'Pesan untuk user (maks 500 karakter). Kosongkan untuk memakai pesan default / mempertahankan pesan lama.',
    example: 'Aplikasi sedang upgrade ke versi baru. Kembali dalam ±30 menit.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
