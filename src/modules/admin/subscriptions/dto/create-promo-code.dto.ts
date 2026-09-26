import { IsInt, IsOptional, IsString, IsDateString, MaxLength, Min, Max, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * POST /v1/admin/subscriptions/promo-codes — buat kode promo langganan GRATIS.
 *
 * Keputusan produk 2026-09-26: admin membuat kode untuk user pilihan dengan
 * durasi bebas (3/7/14/30 hari bahkan 1 tahun). Satu kode default sekali pakai
 * (maxRedemptions=1), bisa diatur admin; bisa dikunci ke user tertentu.
 */
export class CreatePromoCodeDto {
  @ApiProperty({ description: 'Kode promo unik (3-32 karakter: A-Z, 0-9, _, -)', example: 'KAHADPLUS-VIP-001' })
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Z0-9_-]{3,32}$/i, { message: 'code 3-32 karakter: A-Z, 0-9, _, -' })
  code!: string;

  @ApiProperty({ description: 'Durasi langganan gratis dalam hari (1-366)', example: 30 })
  @IsInt()
  @Min(1)
  @Max(366)
  durationDays!: number;

  @ApiPropertyOptional({ description: 'Batas total pemakaian; null = tak terbatas. Default 1 (sekali pakai).', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number | null;

  @ApiPropertyOptional({ description: 'Kunci kode hanya untuk user ini (opsional)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assignedUserId?: string;

  @ApiPropertyOptional({ description: 'Masa berlaku kode (ISO 8601, opsional)' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Catatan admin (mis. nama penerima)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
