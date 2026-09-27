import { IsString, IsInt, IsIn, Min, Max, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EMERGENCY_GRANT_SCOPE_NAMES } from '../../../../common/constants/emergency-grant-scopes';

/**
 * GAP-E (G395) — grant akses darurat berjangka.
 * Hanya SUPER_ADMIN. Kedaluwarsa maks 120 menit.
 *
 * ADM-402: `scope` HANYA menerima kosakata allowlist (USERS/KYC/FINANCE/DISPUTES/ALL).
 * Scope tak dikenal ditolak (400) — tidak ada "rasa aman palsu". Record grant sendiri
 * TIDAK memberi akses apa pun (murni catatan audit); penegakan scope berlaku pada
 * token yang membawa klaim `scope` via JwtAdminGuard.
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
    description:
      'Cakupan akses darurat. Hanya menerima: USERS, KYC, FINANCE, DISPUTES, ALL. ' +
      'Scope yang dikenal ditegakkan sebagai batasan path pada token ber-scope (JwtAdminGuard); ' +
      'record grant sendiri tidak menambah hak akses.',
    example: 'FINANCE',
    enum: EMERGENCY_GRANT_SCOPE_NAMES,
  })
  @IsString()
  @IsIn(EMERGENCY_GRANT_SCOPE_NAMES, { message: 'scope harus salah satu dari: ' + EMERGENCY_GRANT_SCOPE_NAMES.join(', ') })
  scope!: string;

  @ApiProperty({ description: 'Masa berlaku dalam menit (1–120).', minimum: 1, maximum: 120 })
  @IsInt()
  @Min(1)
  @Max(120)
  expiresInMinutes!: number;
}
