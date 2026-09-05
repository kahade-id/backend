import { IsString, IsNotEmpty, IsInt, IsOptional, IsIn, Min, MaxLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class ValidateVoucherDto {
  @ApiProperty({ description: 'Voucher code (A-Z, 0-9, underscore, or hyphen)', maxLength: 30 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  @Matches(/^[A-Z0-9_-]+$/, { message: 'code may contain only A-Z, 0-9, underscore, or hyphen' })
  code!: string;

  @ApiPropertyOptional({
    description: 'Order value in IDR (optional for preview validation)',
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orderValue?: number;

  @ApiPropertyOptional({
    description: 'User role for role-based voucher validation',
    enum: ['BUYER', 'SELLER'],
  })
  @IsOptional()
  @IsString()
  @IsIn(['BUYER', 'SELLER'])
  userRole?: 'BUYER' | 'SELLER';
}
