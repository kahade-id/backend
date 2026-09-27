import { IsString, IsInt, Min, Max, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * GAP-E (G395) — grant akses darurat berjangka.
 * Hanya SUPER_ADMIN. Kedaluwarsa maks 120 menit.
 */
export class CreateEmergencyGrantDto {
  @ApiProperty({ description: 'ID admin penerima akses darurat.' })
  @IsString()
  @MaxLength(100)
  adminId!: string;

  @ApiProperty({ description: 'Alasan grant (wajib) — tercatat di audit.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiProperty({
    description: 'Cakupan akses darurat (mis. "finance:read"). Penegakan scope = follow-up produk.',
    example: 'finance:read',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  scope!: string;

  @ApiProperty({ description: 'Masa berlaku dalam menit (1–120).', minimum: 1, maximum: 120 })
  @IsInt()
  @Min(1)
  @Max(120)
  expiresInMinutes!: number;
}
