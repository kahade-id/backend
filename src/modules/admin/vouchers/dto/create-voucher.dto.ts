import {
  IsString,
  IsNotEmpty,
  IsEnum,
  IsOptional,
  IsInt,
  Min,
  Max,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { VoucherType, VoucherApplicability } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class CreateVoucherDto {
  @ApiProperty({ description: 'Voucher code (A-Z, 0-9, underscore, or hyphen)', maxLength: 30 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(/^[A-Z0-9_-]+$/, { message: 'code may contain only A-Z, 0-9, underscore, or hyphen' })
  code!: string;

  @ApiProperty({ description: 'Voucher name', maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: 'Voucher description', maxLength: 500 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: VoucherType, description: 'Type of voucher' })
  @IsEnum(VoucherType)
  voucherType!: VoucherType;

  @ApiPropertyOptional({ description: 'Discount amount in IDR', minimum: 1, maximum: 50_000_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50_000_000, { message: 'discountAmount cannot exceed Rp 50.000.000' })
  discountAmount?: number;

  @ApiPropertyOptional({
    description: 'Discount percentage (0.01–100)',
    minimum: 0.01,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(0.01)
  @Max(100)
  discountPercent?: number;

  @ApiPropertyOptional({
    description: 'Maximum discount amount in IDR',
    minimum: 1,
    maximum: 50_000_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50_000_000, { message: 'maxDiscountAmount cannot exceed Rp 50.000.000' })
  maxDiscountAmount?: number;

  @ApiPropertyOptional({ description: 'Maximum total usage count', minimum: 1, maximum: 1_000_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxUsageTotal?: number;

  @ApiPropertyOptional({ description: 'Maximum usage per user', minimum: 1, maximum: 10_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxUsagePerUser?: number;

  @ApiProperty({ description: 'Valid from date in ISO 8601 format' })
  @IsDateString()
  validFrom!: string;

  @ApiProperty({ description: 'Valid until date in ISO 8601 format' })
  @IsDateString()
  validUntil!: string;

  @ApiPropertyOptional({
    description: 'Minimum order value in IDR',
    minimum: 0,
    maximum: 1_000_000_000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1_000_000_000, { message: 'minOrderValue cannot exceed Rp 1.000.000.000' })
  minOrderValue?: number;

  @ApiPropertyOptional({ enum: VoucherApplicability, description: 'Applicable to' })
  @IsOptional()
  @IsEnum(VoucherApplicability)
  applicableTo?: VoucherApplicability;
}
