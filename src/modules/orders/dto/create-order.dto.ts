import {
  IsEnum,
  IsString,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
  Max,
  MinLength,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { FeeResponsibility, OrderType, FulfillmentType, ParticipantMode, OrderCategory } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LocationDto } from '../../auth/dto/location.dto';
import {
  ORDER_MIN_VALUE,
  ORDER_MAX_VALUE,
  DELIVERY_DEADLINE_DAYS_MIN,
  DELIVERY_DEADLINE_DAYS_MAX,
} from '../../../common/constants/app.constants';
import { formatIdr } from '../../../common/utils/currency.util';

function sanitizeText(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value.replace(/[<>]/g, '').trim();
}

/**
 * Lokasi presisi buyer saat order dibuat (kontrak disepakati dengan tim frontend).
 * Selalu OPSIONAL — null/absent bila user menolak izin lokasi.
 */
export class BuyerLocationDto {
  @ApiProperty({ description: 'Latitude (-90 s.d. 90)', example: -6.2088 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  latitude!: number;

  @ApiProperty({ description: 'Longitude (-180 s.d. 180)', example: 106.8456 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  longitude!: number;

  @ApiPropertyOptional({ description: 'Akurasi dalam meter (bila dilaporkan OS)', example: 12.5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100000)
  @Type(() => Number)
  accuracy?: number;

  @ApiPropertyOptional({ description: 'Waktu pengambilan lokasi (ISO 8601)', example: '2026-09-28T22:30:00+07:00' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  capturedAt?: string;
}

export class CreateOrderDto {
  @ApiProperty({ enum: ['BUYER', 'SELLER'], description: 'Your role in the order' })
  @IsEnum(['BUYER', 'SELLER'], { message: 'role must be BUYER or SELLER' })
  role!: 'BUYER' | 'SELLER';

  @ApiProperty({ description: 'Username of the counterpart', minLength: 3, maxLength: 30 })
  @IsString()
  @MinLength(3)
  @MaxLength(30)
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
  @Min(ORDER_MIN_VALUE, { message: `Minimum order value is ${formatIdr(ORDER_MIN_VALUE)}` })
  @Max(ORDER_MAX_VALUE, { message: `Maximum order value is ${formatIdr(ORDER_MAX_VALUE)}` })
  orderValue!: number;

  @ApiProperty({ description: 'Delivery deadline in days', minimum: DELIVERY_DEADLINE_DAYS_MIN, maximum: DELIVERY_DEADLINE_DAYS_MAX })
  @IsInt()
  @Min(DELIVERY_DEADLINE_DAYS_MIN)
  @Max(DELIVERY_DEADLINE_DAYS_MAX)
  deliveryDeadlineDays!: number;

  @ApiPropertyOptional({
    description: 'Explicit delivery deadline as ISO 8601 date-time (e.g. "2026-10-05T16:59:59+07:00"). '
      + 'When provided and valid (tomorrow … +14 days), it takes precedence over deliveryDeadlineDays '
      + 'and is stored as the order\'s deliveryDeadlineAt. Lets the user pick a calendar date instead of a day count.',
    example: '2026-10-05T16:59:59+07:00',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  deliveryDeadlineAt?: string;

  @ApiProperty({ enum: FeeResponsibility, description: 'Who pays the fee' })
  @IsEnum(FeeResponsibility, { message: 'feeResponsibility must be BUYER, SELLER, or SPLIT' })
  feeResponsibility!: FeeResponsibility;

  @ApiPropertyOptional({ description: 'Voucher code to apply', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  voucherCode?: string;

  @ApiPropertyOptional({
    description: 'ID alamat pengiriman dari buku alamat pembuat order. WAJIB untuk orderType PHYSICAL_GOODS (server menolak tanpa ini); diabaikan untuk tipe lain.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  shippingAddressId?: string;

  @ApiPropertyOptional({ description: 'Reference attachment URLs (R2 CDN) for order spec — max 5', type: [String] })
  @IsOptional()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  attachments?: string[];

  @ApiPropertyOptional({ description: 'Source inquiry room ID if order originates from an INQUIRY chat (links negotiation context)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  inquiryRoomId?: string;

  @ApiPropertyOptional({ enum: FulfillmentType, description: 'TX-UNIFIED-V2: BIASA (ready stock) atau PREORDER (fulfill nanti). Default BIASA.' })
  @IsOptional()
  @IsEnum(FulfillmentType, { message: 'fulfillment must be BIASA or PREORDER' })
  fulfillment?: FulfillmentType;

  @ApiPropertyOptional({ enum: ParticipantMode, description: 'TX-UNIFIED-V2: SINGLE (1-by-1) atau GROUP (1-by-N patungan). Default SINGLE.' })
  @IsOptional()
  @IsEnum(ParticipantMode, { message: 'participantMode must be SINGLE or GROUP' })
  participantMode?: ParticipantMode;

  @ApiPropertyOptional({ enum: OrderCategory, description: 'TX-UNIFIED-V2: FISIK, DIGITAL, atau JASA. Default diturunkan dari orderType.' })
  @IsOptional()
  @IsEnum(OrderCategory, { message: 'category must be FISIK, DIGITAL, or JASA' })
  category?: OrderCategory;

  @ApiPropertyOptional({ description: 'TX-UNIFIED-V2: estimasi tanggal fulfillment untuk PREORDER (ISO 8601). Wajib jika fulfillment=PREORDER.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  preorderEstimatedDate?: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional — null/absent bila user menolak izin GPS)', type: () => LocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  deviceLocation?: LocationDto | null;

  @ApiPropertyOptional({
    description: 'Lokasi presisi buyer saat order dibuat (opsional — null/absent bila user menolak izin lokasi). Disimpan terenkripsi, tampil di detail order admin untuk fraud checking.',
    type: () => BuyerLocationDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => BuyerLocationDto)
  buyerLocation?: BuyerLocationDto | null;
}
