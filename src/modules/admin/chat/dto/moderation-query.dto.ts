import { IsOptional, IsInt, Min, Max, IsString, IsIn, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ModerationEventQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: ['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED'] })
  @IsOptional()
  @IsString()
  @IsIn(['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED'])
  status?: string;

  @ApiPropertyOptional({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] })
  @IsOptional()
  @IsString()
  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  severity?: string;

  @ApiPropertyOptional({ enum: ['BLOCKED', 'REDACTED', 'FLAGGED'] })
  @IsOptional()
  @IsString()
  @IsIn(['BLOCKED', 'REDACTED', 'FLAGGED'])
  action?: string;

  @ApiPropertyOptional({ enum: ['CIRCUMVENTION', 'CONTACT_SHARING', 'PROFANITY', 'SPAM'] })
  @IsOptional()
  @IsString()
  @IsIn(['CIRCUMVENTION', 'CONTACT_SHARING', 'PROFANITY', 'SPAM'])
  kind?: string;
}

export class ReviewModerationEventDto {
  @ApiPropertyOptional({ enum: ['REVIEWED', 'DISMISSED', 'ACTIONED'], default: 'REVIEWED' })
  @IsOptional()
  @IsString()
  @IsIn(['REVIEWED', 'DISMISSED', 'ACTIONED'])
  status?: string = 'REVIEWED';

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
