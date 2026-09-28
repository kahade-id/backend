import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UploadPurpose } from './presigned-url.dto';

/**
 * NP-006 (perf-fix, 2026-09-29): DTO init sesi upload chunked/resumable.
 *
 * `totalChunks` TIDAK dikirim client — dihitung server dari
 * `totalSize / chunkSize` (disepakati & di-clamp server) supaya tidak ada
 * mismatch yang bisa dieksploitasi.
 */
export class InitChunkedUploadDto {
  @ApiProperty({ enum: UploadPurpose, description: 'Tujuan upload — menentukan batas ukuran & MIME yang diizinkan.' })
  @IsEnum(UploadPurpose)
  purpose!: UploadPurpose;

  @ApiProperty({ example: 'video-produk.mp4', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ example: 'video/mp4', maxLength: 100 })
  @IsString()
  @MaxLength(100)
  mimeType!: string;

  @ApiProperty({ example: 52_428_800, description: 'Total ukuran file dalam byte. Harus ≤ batas purpose.' })
  @IsInt()
  @Min(1)
  @Max(2 * 1024 * 1024 * 1024)
  totalSize!: number;

  @ApiPropertyOptional({
    example: 4_194_304,
    description: 'Ukuran chunk yang diinginkan (byte). Di-clamp server ke [512KiB, 8MiB]; default 4MiB.',
  })
  @IsOptional()
  @IsInt()
  @Min(512 * 1024)
  @Max(8 * 1024 * 1024)
  chunkSize?: number;
}
