import { IsOptional, IsEnum, IsString, IsInt, Min, Max } from 'class-validator';
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

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
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
}
