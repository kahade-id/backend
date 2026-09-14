import { IsOptional, IsEnum, IsString, IsInt, Min, Max, IsDateString } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { OrderStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GetOrdersQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  @ApiPropertyOptional({ description: 'Order status filter (use ACTIVE for all active statuses)' })
  @IsOptional()
  @IsString()
  @IsEnum([...Object.values(OrderStatus), 'ACTIVE'], { message: 'Invalid order status filter' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toUpperCase() : value)
  status?: string;

  @ApiPropertyOptional({ enum: ['BUYER', 'SELLER', 'ALL'] })
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toUpperCase() : value)
  @IsEnum(['BUYER', 'SELLER', 'ALL'] as const, { message: 'Role must be BUYER, SELLER, or ALL' })
  role?: 'BUYER' | 'SELLER' | 'ALL';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter from date (YYYY-MM-DD) — WIB' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Filter to date (YYYY-MM-DD) — WIB' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ description: 'Sort by field', enum: ['createdAt', 'orderValue', 'deliveryDeadlineAt', 'updatedAt'] })
  @IsOptional()
  @IsEnum(['createdAt', 'orderValue', 'deliveryDeadlineAt', 'updatedAt'])
  sortBy?: 'createdAt' | 'orderValue' | 'deliveryDeadlineAt' | 'updatedAt';

  @ApiPropertyOptional({ description: 'Sort order', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsEnum(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
