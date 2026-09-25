import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * Lokasi presisi perangkat saat momen sensitif auth.
 * Selalu OPSIONAL — bila user menolak izin lokasi, client mengirim
 * null/tidak mengirim field ini dan backend fallback ke IP address.
 */
export class LocationDto {
  @ApiProperty({ description: 'Latitude (-90 s.d. 90)', example: -6.2 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude!: number;

  @ApiProperty({ description: 'Longitude (-180 s.d. 180)', example: 106.85 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude!: number;

  @ApiPropertyOptional({ description: 'Akurasi dalam meter (bila dilaporkan OS)', example: 12.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  @Type(() => Number)
  accuracy?: number;

  @ApiPropertyOptional({ description: 'Waktu pengambilan lokasi (ISO 8601)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  timestamp?: string;

  @ApiPropertyOptional({ description: 'Sumber lokasi: gps | network | fused | ip', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  source?: string;
}
