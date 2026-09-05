import { IsOptional, IsString, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class AuditLogQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by action type' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Filter by admin ID' })
  @IsOptional()
  @IsString()
  adminId?: string;

  @ApiPropertyOptional({ description: 'Filter by target resource type (e.g. USER, ORDER, KYC)' })
  @IsOptional()
  @IsString()
  targetType?: string;

  @ApiPropertyOptional({ description: 'Start date in ISO 8601 format' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date in ISO 8601 format' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class WebhookLogQueryDto extends PaginationDto {
  @ApiPropertyOptional({ description: 'Filter by webhook source' })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({ description: 'Filter by processed status' })
  @IsOptional()
  @IsString()
  isProcessed?: string;

  @ApiPropertyOptional({ description: 'Filter dead-letter state' })
  @IsOptional()
  @IsString()
  deadLettered?: string;

  @ApiPropertyOptional({ description: 'Full-text search across source, event, and errorMessage fields' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Filter logs received on or after this date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Filter logs received on or before this date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
