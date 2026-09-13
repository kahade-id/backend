import { IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignStatus, MembershipRank } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return value;
};

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

  @ApiPropertyOptional({ description: 'Unique public promo code for the campaign', example: 'SEPTCASHBACK' })
  @IsOptional() @IsString() @MinLength(3) @MaxLength(32) @Matches(/^[A-Za-z0-9_-]+$/) @Transform(trim)
  promoCode?: string;

  @ApiPropertyOptional({ description: 'Legacy display-only audience label' })
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim)
  targetAudience?: string;

  @ApiPropertyOptional({ enum: MembershipRank, description: 'Minimum membership rank eligible for generated vouchers' })
  @IsOptional() @IsEnum(MembershipRank)
  targetMinRank?: MembershipRank;

  @ApiPropertyOptional({ description: 'Dormant targeting: minimum days since last completed order', minimum: 1, maximum: 3650 })
  @IsOptional() @IsInt() @Min(1) @Max(3650)
  targetDormantDays?: number;

  @ApiPropertyOptional({ description: 'Only target users with zero completed orders' })
  @IsOptional() @IsBoolean() @Transform(toBoolean)
  targetNewUserOnly?: boolean;

  @ApiPropertyOptional({ description: 'Max total redemptions', minimum: 1, maximum: 10_000_000 })
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000)
  maxRedemptions?: number;

  @ApiPropertyOptional({ enum: CampaignStatus, description: 'Campaign status. PAUSED stops new voucher issuance; ENDED is permanent.' })
  @IsOptional() @IsEnum(CampaignStatus)
  status?: CampaignStatus;

  @ApiPropertyOptional({ description: 'Staged rollout percentage (0-100). Can only be increased once set.', minimum: 0, maximum: 100 })
  @IsOptional() @IsNumber() @Min(0) @Max(100)
  rolloutPercent?: number;
}
