import { IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class BusinessVerificationSummaryQueryDto {
  @ApiPropertyOptional({
    enum: ['7d', '30d', '90d'],
    description: 'Periode ringkasan volume. Default: 30d.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['7d', '30d', '90d'])
  period?: string;
}
