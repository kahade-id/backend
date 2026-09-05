import {
  IsString, IsOptional, IsEnum, IsArray, IsNumber, IsInt,
  Min, Max, MinLength, MaxLength, ArrayMaxSize, IsIn,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { FeeResponsibility } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ORDER_MIN_VALUE, ORDER_MAX_VALUE } from '../../../common/constants/app.constants';

function sanitizeText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/[<>]/g, '').trim();
}

export class CalculateFeeDto {
  @ApiProperty({ description: 'Order value in IDR', minimum: ORDER_MIN_VALUE, maximum: ORDER_MAX_VALUE })
  @IsNumber({ maxDecimalPlaces: 0 })
  @IsInt()
  @Min(ORDER_MIN_VALUE)
  @Max(ORDER_MAX_VALUE)
  orderValue!: number;

  @ApiProperty({ enum: FeeResponsibility, description: 'Who pays the fee' })
  @IsEnum(FeeResponsibility)
  feeResponsibility!: FeeResponsibility;

  @ApiPropertyOptional({ description: 'Voucher code to apply', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  voucherCode?: string;

  @ApiPropertyOptional({ description: 'User role for role-based voucher validation', enum: ['BUYER', 'SELLER'] })
  @IsOptional()
  @IsString()
  @IsIn(['BUYER', 'SELLER'])
  role?: 'BUYER' | 'SELLER';
}

export class ConfirmOrderDto {
  @ApiProperty({ enum: ['ACCEPT', 'REJECT'], description: 'Accept or reject the order' })
  @IsEnum(['ACCEPT', 'REJECT'])
  action!: 'ACCEPT' | 'REJECT';

  @ApiPropertyOptional({ description: 'Reason for rejection', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateShippingDto {
  @ApiPropertyOptional({ description: 'Tracking number; required for PHYSICAL_GOODS only', minLength: 3, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  trackingNumber?: string;

  @ApiPropertyOptional({ description: 'Courier name; required for PHYSICAL_GOODS only', minLength: 2, maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  courierName?: string;

  @ApiPropertyOptional({ description: 'Tracking notes', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  trackingNotes?: string;
}

export class RequestExtensionDto {
  @ApiProperty({ description: 'Number of extension days', minimum: 1, maximum: 14 })
  @IsInt()
  @Min(1)
  @Max(14)
  extensionDays!: number;

  @ApiProperty({ description: 'Reason for extension', minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class RespondExtensionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'], description: 'Approve or reject extension' })
  @IsEnum(['APPROVE', 'REJECT'])
  action!: 'APPROVE' | 'REJECT';

  @ApiPropertyOptional({ description: 'Response note', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CancelOrderDto {
  @ApiProperty({
    description: 'Cancellation reason',
    enum: ['CHANGED_MIND', 'WRONG_DETAILS', 'DUPLICATE_ORDER', 'MUTUAL_AGREEMENT', 'COUNTERPART_UNRESPONSIVE', 'OTHER'],
  })
  @IsIn(['CHANGED_MIND', 'WRONG_DETAILS', 'DUPLICATE_ORDER', 'MUTUAL_AGREEMENT', 'COUNTERPART_UNRESPONSIVE', 'OTHER'], {
    message: 'reason must be one of: CHANGED_MIND, WRONG_DETAILS, DUPLICATE_ORDER, MUTUAL_AGREEMENT, COUNTERPART_UNRESPONSIVE, OTHER',
  })
  reason!: string;

  @ApiPropertyOptional({ description: 'Additional cancellation note', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Transform(({ value }: { value: unknown }) => sanitizeText(value))
  note?: string;
}

export class SubmitDisputeDto {
  @ApiProperty({ description: 'Dispute claim', minLength: 20, maxLength: 2000 })
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  claim!: string;

  @ApiProperty({ description: 'Evidence file URLs', type: [String], minItems: 0, maxItems: 10, required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  fileUrls?: string[];

  @ApiProperty({ description: 'Evidence file MIME types', type: [String], maxItems: 10, required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], { each: true, message: 'Invalid file type. Allowed: image/jpeg, image/png, image/webp, application/pdf' })
  fileTypes?: string[];
}

export class ValidateCounterpartDto {
  @ApiProperty({ description: 'Username to validate', minLength: 3, maxLength: 50 })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  username!: string;
}

export class PayOrderDto {
  @ApiProperty({ description: '6-digit wallet PIN for payment authorization', required: true })
  @IsString()
  @MinLength(6)
  @MaxLength(6)
  pin!: string;
}
