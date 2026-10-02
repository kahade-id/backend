import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * BAD-028: reason opsional untuk aksi sensitif manajemen admin
 * (reset-2fa, reset-password, unlock, delete). Tercatat di audit trail.
 */
export class AdminActionReasonDto {
  @ApiPropertyOptional({ description: 'Alasan aksi (opsional) — tercatat di audit trail.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * BAD-029: reason WAJIB untuk reaktivasi akun admin (audit ADMIN_REACTIVATED).
 */
export class ReactivateAdminDto {
  @ApiProperty({ description: 'Alasan reaktivasi (wajib) — tercatat di audit ADMIN_REACTIVATED.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
