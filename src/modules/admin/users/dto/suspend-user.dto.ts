import { IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * BAI-074 — suspend ringan berbatas waktu.
 *
 * State suspend disimpan di Redis dengan TTL (= auto-unsuspend, tanpa cron
 * dan tanpa kolom DB baru). Sesi aktif dicabut saat suspend (kick langsung);
 * sesi yang dicabut TIDAK dipulihkan saat unsuspend — user login ulang.
 */
export class SuspendUserDto {
  @ApiProperty({ description: 'Alasan suspend', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @Matches(/\S/, { message: 'Reason must contain at least one non-whitespace character' })
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: 'Durasi suspend (jam). Maks 720 jam (30 hari).', minimum: 1, maximum: 720 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  durationHours!: number;
}
