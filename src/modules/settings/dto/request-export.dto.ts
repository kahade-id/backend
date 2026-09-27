import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * G098: format arsip ekspor. `json` = satu berkas JSON terstruktur;
 * `csv` = ZIP berisi manifest + file per dataset (CSV untuk dataset tabular).
 */
export class RequestExportDto {
  @ApiPropertyOptional({ description: 'Format arsip ekspor', enum: ['json', 'csv'], default: 'json' })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
