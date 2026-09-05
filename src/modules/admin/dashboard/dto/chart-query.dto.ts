import { IsOptional, IsIn, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ChartQueryDto {
  @ApiPropertyOptional({ enum: ['7d', '30d', '90d', '1y'], default: '30d' })
  @IsOptional()
  @IsIn(['7d', '30d', '90d', '1y'])
  period?: string = '30d';

  @ApiPropertyOptional({ description: 'Start date filter' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date filter' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
