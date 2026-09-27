/**
 * DTO modul kurir (G226–G250). Copy validasi Bahasa Indonesia.
 */
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ShipmentMode, ShippingCostBearer } from '@prisma/client';

const POSTAL_RE = /^\d{5}$/;

export class AddressDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  name!: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  phone!: string;

  @IsString() @IsNotEmpty() @MinLength(10) @MaxLength(300)
  address!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  city!: string;

  @IsString() @Matches(POSTAL_RE, { message: 'Kode pos harus 5 digit angka' })
  postalCode!: string;

  @IsString() @IsOptional() @MaxLength(100)
  province?: string;
}

export class QuoteRequestDto {
  @IsString() @Matches(POSTAL_RE, { message: 'Kode pos asal harus 5 digit angka' })
  originPostalCode!: string;

  @IsString() @Matches(POSTAL_RE, { message: 'Kode pos tujuan harus 5 digit angka' })
  destinationPostalCode!: string;

  @IsString() @IsOptional() @MaxLength(100)
  originCity?: string;

  @IsString() @IsOptional() @MaxLength(100)
  destinationCity?: string;

  @IsInt() @Min(1) @Max(100000)
  weightGrams!: number;

  /** Urutan: "price" | "eta" (G230). */
  @IsString() @IsOptional() @IsIn(['price', 'eta'])
  sort?: 'price' | 'eta';

  /** Filter kode provider opsional. */
  @IsArray() @IsString({ each: true }) @IsOptional()
  providers?: string[];
}

export class CreateShipmentDto {
  /** Order ID publik (orderId), bukan cuid internal. */
  @IsString() @IsNotEmpty()
  orderId!: string;

  @IsString() @IsNotEmpty() @MaxLength(20)
  providerCode!: string;

  @IsString() @IsOptional() @MaxLength(20)
  serviceCode?: string;

  @IsEnum(ShipmentMode)
  @IsOptional()
  mode?: ShipmentMode;

  @IsEnum(ShippingCostBearer)
  @IsOptional()
  costBearer?: ShippingCostBearer;

  @ValidateNested() @Type(() => AddressDto)
  origin!: AddressDto;

  @ValidateNested() @Type(() => AddressDto)
  destination!: AddressDto;

  @IsInt() @Min(1) @Max(100000)
  weightGrams!: number;

  /** Ongkir estimasi dari quote yang dipilih user (dicatat terpisah dari aktual). */
  @IsNumber() @Min(0) @IsOptional()
  estimatedCost?: number;
}

export class BookShipmentDto {
  @IsString() @IsOptional() @MaxLength(300)
  note?: string;
}

export class VoidShipmentDto {
  @IsString() @IsNotEmpty() @MinLength(5) @MaxLength(300)
  reason!: string;
}

export class ManualResiDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  trackingNumber!: string;

  @IsString() @IsNotEmpty() @MaxLength(100)
  courierName!: string;

  @IsString() @IsOptional() @MaxLength(300)
  note?: string;
}

export class UpdateCatalogDto {
  @IsBoolean() @IsOptional()
  enabled?: boolean;

  @IsArray() @IsString({ each: true }) @IsOptional()
  regions?: string[];

  @IsInt() @Min(0) @Max(30) @IsOptional()
  slaGraceDays?: number;

  @IsBoolean() @IsOptional()
  supportsPickup?: boolean;

  @IsBoolean() @IsOptional()
  supportsDropoff?: boolean;
}

export class ToggleFlagDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString() @IsOptional() @MaxLength(300)
  note?: string;
}

export class CreateBillDto {
  @IsString() @IsNotEmpty() @MaxLength(20)
  providerCode!: string;

  @IsString() @Matches(/^\d{4}-\d{2}$/, { message: 'Periode harus format YYYY-MM' })
  period!: string;

  @IsNumber() @Min(0)
  billedAmount!: number;

  @IsString() @IsOptional() @MaxLength(500)
  notes?: string;
}

export class BillLineDto {
  @IsString() @IsOptional() @MaxLength(100)
  trackingNumber?: string;

  @IsString() @IsOptional()
  shipmentId?: string;

  @IsNumber() @Min(0)
  billedAmount!: number;
}

export class RequestRefundDto {
  @IsNumber() @Min(1)
  amount!: number;

  @IsString() @IsNotEmpty() @MinLength(5) @MaxLength(500)
  reason!: string;
}

export class DecideRefundDto {
  @IsString() @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsString() @IsOptional() @MaxLength(500)
  note?: string;
}
