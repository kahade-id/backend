import { IsOptional, IsEnum, IsString, IsBoolean, IsIn, IsDateString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';
import { OrderStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { PaginationDto } from '../../../../common/dto/pagination.dto';

export class AdminOrderQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: OrderStatus, description: 'Filter by order status' })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ description: 'Start date filter' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date filter' })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: 'Search by order ID or user' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  search?: string;

  @ApiPropertyOptional({ description: 'Filter orders with escrow' })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hasEscrow?: boolean;

  @ApiPropertyOptional({ enum: ['createdAt', 'updatedAt', 'orderValue', 'status', 'buyerPayAmount', 'completedAt'], description: 'Sort field' })
  @IsOptional()
  @IsIn(['createdAt', 'updatedAt', 'orderValue', 'status', 'buyerPayAmount', 'completedAt'])
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Sort direction' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

export class ForceActionDto {
  @ApiProperty({ description: 'Reason for force action', minLength: 10, maxLength: 500 })
  @IsNotEmpty()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  reason!: string;
}
