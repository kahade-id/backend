import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MODERATION_REASON_CODES } from '../moderation-prisma.types';

/**
 * G411 — assign/handoff laporan ke admin.
 * Tanpa assigneeAdminId → auto-assign ke admin dengan antrean terbuka tersedikit.
 */
export class AssignShowcaseReportDto {
  @ApiPropertyOptional({
    description: 'ID admin tujuan. Kosong = auto-assign berdasarkan beban antrean.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigneeAdminId?: string;

  @ApiPropertyOptional({
    description: 'Kode alasan moderasi terstandar (G412)',
    enum: [...MODERATION_REASON_CODES],
  })
  @IsOptional()
  @IsString()
  @IsIn([...MODERATION_REASON_CODES])
  reasonCode?: string;
}
