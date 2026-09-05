import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CampaignType } from '@prisma/client';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class CreateCampaignDto {
  @ApiProperty({ description: 'Campaign name', minLength: 3, maxLength: 100 })
  @IsString() @MinLength(3) @MaxLength(100) @Matches(/\S/, { message: 'name cannot be blank' }) @Transform(trim)
  name!: string;

  @ApiPropertyOptional({ description: 'Campaign description', maxLength: 1000 })
  @IsOptional() @IsString() @MaxLength(1000) @Transform(trim)
  description?: string;

  @ApiProperty({ enum: CampaignType, description: 'Campaign type' })
  @IsEnum(CampaignType)
  type!: CampaignType;

  @ApiProperty({ description: 'Campaign start date (ISO 8601)' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ description: 'Campaign end date (ISO 8601)' })
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional({ description: 'Flat discount value (IDR)', minimum: 1, maximum: 50_000_000 })
  @IsOptional() @IsInt() @Min(1) @Max(50_000_000, { message: 'discountValue cannot exceed Rp 50.000.000' })
  discountValue?: number;

  @ApiPropertyOptional({ description: 'Discount percentage (0.01-100)' })
  @IsOptional() @IsNumber() @Min(0.01) @Max(100)
  discountPercent?: number;

  @ApiPropertyOptional({ description: 'Max discount cap (IDR)', minimum: 1, maximum: 50_000_000 })
  @IsOptional() @IsInt() @Min(1) @Max(50_000_000, { message: 'maxDiscount cannot exceed Rp 50.000.000' })
  maxDiscount?: number;

  @ApiPropertyOptional({ description: 'Number of free transactions', minimum: 1, maximum: 1_000_000 })
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000)
  freeTransactions?: number;

  @ApiPropertyOptional({ description: 'Target audience filter' })
  @IsOptional() @IsString() @MaxLength(500) @Transform(trim)
  targetAudience?: string;

  @ApiPropertyOptional({ description: 'Max total redemptions', minimum: 1, maximum: 10_000_000 })
  @IsOptional() @IsInt() @Min(1) @Max(10_000_000)
  maxRedemptions?: number;
}
