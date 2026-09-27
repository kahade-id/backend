import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

/**
 * G421 — export CSV/JSON untuk audit kepatuhan.
 * Description diredaksi (dipotong); PII pelapor/pemilik tidak ikut.
 */
export class ExportShowcaseReportsQueryDto {
  @ApiPropertyOptional({ description: 'Format export', enum: ['csv', 'json'], default: 'csv' })
  @IsOptional()
  @IsString()
  @IsIn(['csv', 'json'])
  format?: string;

  @ApiPropertyOptional({ description: 'Filter status ReportStatus' })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ description: 'Tanggal mulai (ISO)' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'Tanggal akhir (ISO)' })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({ description: 'Maksimum baris', default: 5000 })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;
}
