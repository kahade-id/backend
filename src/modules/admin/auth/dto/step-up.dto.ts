import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * SEC-503: minta token step-up — verifikasi password admin untuk SATU aksi
 * spesifik. Token yang diterbitkan sekali pakai, TTL 3 menit, terikat
 * action (+ targetId opsional), wajib dikirim via header X-Step-Up-Token
 * pada endpoint yang dijaga @RequireStepUp().
 */
export class StepUpRequestDto {
  @ApiProperty({ description: 'Password admin (re-auth untuk aksi ini)', maxLength: 72 })
  @IsNotEmpty()
  @IsString()
  @MaxLength(72)
  password!: string;

  @ApiProperty({
    description:
      'Aksi yang diikat ke token — harus sama dengan action @RequireStepUp endpoint tujuan ' +
      '(mis. DISPUTE_RESOLVE, WALLET_ADJUST, APPROVAL_APPROVE)',
    maxLength: 120,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(120)
  action!: string;

  @ApiPropertyOptional({
    description: 'ID target aksi (mis. disputeId, orderId) — diikat ke token bila diisi',
    maxLength: 120,
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  targetId?: string;
}
