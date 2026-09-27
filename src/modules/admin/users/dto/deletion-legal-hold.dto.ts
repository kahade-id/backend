import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * GAP-A (G067): alasan retensi hukum saat menahan penghapusan akun.
 */
export class DeletionLegalHoldDto {
  @ApiProperty({ description: 'Alasan legal hold (mis. nomor sengketa / dasar retensi hukum)', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
