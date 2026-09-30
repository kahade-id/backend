import { IsOptional, IsIn, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ChartQueryDto {
  // BAI-131: JANGAN beri property initializer di sini. Dengan
  // `transform: true` di ValidationPipe global, initializer selalu aktif saat
  // query `period` tidak dikirim — sehingga cabang 'custom' di
  // DashboardService.getDateRange (ADM-025) tidak pernah tercapai dan respons
  // berbohong mengklaim `period: '30d'` untuk rentang kustom. Default '30d'
  // diterapkan eksplisit di getDateRange (bukan di DTO).
  @ApiPropertyOptional({ enum: ['7d', '30d', '90d', '1y'], default: '30d' })
  @IsOptional()
  @IsIn(['7d', '30d', '90d', '1y'])
  period?: string;

  @ApiPropertyOptional({ description: 'Start date filter' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date filter' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
