import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignStatus } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class UpdateCampaignDto {
  @ApiPropertyOptional({ description: 'Campaign name', minLength: 3, maxLength: 100 })
  @IsOptional() @IsString() @MinLength(3) @MaxLength(100) @Matches(/\S/, { message: 'name cannot be blank' }) @Transform(trim)
  name?: string;

  @ApiPropertyOptional({ description: 'Campaign description', maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim)
  description?: string;

  @ApiPropertyOptional({ description: 'Campaign start date (ISO 8601)' })
  @IsOptional() @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ description: 'Campaign end date (ISO 8601)' })
  @IsOptional() @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ description: 'Max total redemptions', minimum: 1, maximum: 10_000_000 })
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000)
  maxRedemptions?: number;

  @ApiPropertyOptional({ enum: CampaignStatus, description: 'Campaign status' })
  @IsOptional() @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @ApiPropertyOptional({ description: 'Staged rollout percentage (0-100). Can only be increased once set.', minimum: 0, maximum: 100 })
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  rolloutPercent?: number;
}
