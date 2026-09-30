import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, Transform } from 'class-transformer';

/**
 * G411 — antrean prioritas moderasi: filter risiko + badge overdue.
 *
 * BAI-034 (audit integrasi 2026-09-30): JANGAN pakai `@Type(() => Boolean)`
 * untuk flag query — class-transformer mengubah string "false" menjadi
 * `true` (Boolean("false") === true), sehingga `?overdueOnly=false` memfilter
 * SEOLAH true. Pakai Transform ketat di bawah: hanya string "true"/"false"
 * (atau boolean asli) yang diterima; nilai lain diteruskan apa adanya agar
 * @IsBoolean menolaknya dengan 400 yang jelas.
 */
export function strictBooleanTransform({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
}
export class ModerationQueueQueryDto {
  @ApiPropertyOptional({ description: 'Halaman', default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Batas per halaman', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({
    description: 'Filter tier risiko (dihitung on-the-fly bila belum di-assign)',
    enum: ['HIGH', 'MEDIUM', 'LOW'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['HIGH', 'MEDIUM', 'LOW'])
  riskTier?: string;

  @ApiPropertyOptional({ description: 'Hanya yang melewati SLA', default: false })
  // BAI-034 — lihat strictBooleanTransform di atas.
  @Transform(strictBooleanTransform)
  @IsOptional()
  @IsBoolean()
  overdueOnly?: boolean;

  @ApiPropertyOptional({ description: 'Urutkan: risk | oldest | newest', default: 'risk' })
  @IsOptional()
  @IsString()
  @IsIn(['risk', 'oldest', 'newest'])
  sort?: string;

  @ApiPropertyOptional({ description: 'Filter assignee (admin id)' })
  @IsOptional()
  @IsString()
  assigneeAdminId?: string;
}
