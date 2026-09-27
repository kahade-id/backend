import { IsOptional, IsISO8601 } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class KycMetricsQueryDto {
  @ApiPropertyOptional({ description: 'Awal periode (ISO 8601). Default: 30 hari lalu.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Akhir periode (ISO 8601). Default: sekarang.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
