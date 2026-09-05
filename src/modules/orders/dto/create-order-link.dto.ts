import {
  IsEnum, IsString, IsInt, IsOptional,
  Min, Max, MinLength, MaxLength,
} from 'class-validator';
import { FeeResponsibility, OrderType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ORDER_MIN_VALUE, ORDER_MAX_VALUE,
  DELIVERY_DEADLINE_DAYS_MIN, DELIVERY_DEADLINE_DAYS_MAX,
} from '../../../common/constants/app.constants';

export class CreateOrderLinkDto {
  @ApiProperty({ enum: ['BUYER', 'SELLER'] })
  @IsEnum(['BUYER', 'SELLER'], { message: 'role must be BUYER or SELLER' })
  role!: 'BUYER' | 'SELLER';

  @ApiProperty({ minLength: 3, maxLength: 100 })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  title!: string;

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  description!: string;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  orderType!: OrderType;

  @ApiProperty({ minimum: ORDER_MIN_VALUE, maximum: ORDER_MAX_VALUE })
  @IsInt()
  @Min(ORDER_MIN_VALUE)
  @Max(ORDER_MAX_VALUE)
  orderValue!: number;

  @ApiProperty({ minimum: DELIVERY_DEADLINE_DAYS_MIN, maximum: DELIVERY_DEADLINE_DAYS_MAX })
  @IsInt()
  @Min(DELIVERY_DEADLINE_DAYS_MIN)
  @Max(DELIVERY_DEADLINE_DAYS_MAX)
  deliveryDeadlineDays!: number;

  @ApiProperty({ enum: FeeResponsibility })
  @IsEnum(FeeResponsibility)
  feeResponsibility!: FeeResponsibility;

  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  counterpartUsername?: string;
}
