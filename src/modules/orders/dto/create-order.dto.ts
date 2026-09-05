import {
  IsEnum,
  IsString,
  IsInt,
  IsOptional,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { FeeResponsibility, OrderType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ORDER_MIN_VALUE,
  ORDER_MAX_VALUE,
  DELIVERY_DEADLINE_DAYS_MIN,
  DELIVERY_DEADLINE_DAYS_MAX,
} from '../../../common/constants/app.constants';

function sanitizeText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/[<>]/g, '').trim();
}

export class CreateOrderDto {
  @ApiProperty({ enum: ['BUYER', 'SELLER'], description: 'Your role in the order' })
  @IsEnum(['BUYER', 'SELLER'], { message: 'role must be BUYER or SELLER' })
  role!: 'BUYER' | 'SELLER';

  @ApiProperty({ description: 'Username of the counterpart', minLength: 3, maxLength: 50 })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  counterpartUsername!: string;

  @ApiProperty({ description: 'Order title', minLength: 3, maxLength: 100 })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  @Transform(({ value }: { value: unknown }) => sanitizeText(value))
  title!: string;

  @ApiProperty({ description: 'Order description', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) => sanitizeText(value))
  description!: string;

  @ApiProperty({ enum: OrderType, description: 'Type of order' })
  @IsEnum(OrderType, { message: 'orderType must be a valid OrderType enum value' })
  orderType!: OrderType;

  @ApiProperty({ description: 'Order value in IDR', minimum: ORDER_MIN_VALUE, maximum: ORDER_MAX_VALUE })
  @IsInt()
  @Min(ORDER_MIN_VALUE, { message: `Minimum order value is Rp ${ORDER_MIN_VALUE.toLocaleString()}` })
  @Max(ORDER_MAX_VALUE, { message: `Maximum order value is Rp ${ORDER_MAX_VALUE.toLocaleString()}` })
  orderValue!: number;

  @ApiProperty({ description: 'Delivery deadline in days', minimum: DELIVERY_DEADLINE_DAYS_MIN, maximum: DELIVERY_DEADLINE_DAYS_MAX })
  @IsInt()
  @Min(DELIVERY_DEADLINE_DAYS_MIN)
  @Max(DELIVERY_DEADLINE_DAYS_MAX)
  deliveryDeadlineDays!: number;

  @ApiProperty({ enum: FeeResponsibility, description: 'Who pays the fee' })
  @IsEnum(FeeResponsibility, { message: 'feeResponsibility must be BUYER, SELLER, or SPLIT' })
  feeResponsibility!: FeeResponsibility;

  @ApiPropertyOptional({ description: 'Voucher code to apply', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  voucherCode?: string;
}
