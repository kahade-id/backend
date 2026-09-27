import { IsString, MinLength, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** GAP-E — suspend akun admin (alasan wajib). Riwayat audit dipertahankan. */
export class SuspendAdminDto {
  @ApiProperty({ description: 'Alasan suspend (wajib) — tercatat di audit ADMIN_SUSPENDED.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
