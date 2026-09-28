import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsDateString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ProductType,
  VoucherType,
  DigitalAssetType,
  PatunganMode,
  AgreementStatus,
} from '@prisma/client';

// ── Item 1: tipe produk & field commerce showcase ────────────────────────────

export class UpdateProductCommerceDto {
  @ApiPropertyOptional({ enum: ProductType, description: 'JASA/FISIK/DIGITAL/LAINNYA' })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiPropertyOptional({ description: 'Harga coret (IDR, harus > harga jual)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000_000)
  originalPriceIdr?: number;

  @ApiPropertyOptional({ description: 'Tenggat pengerjaan (hari) — wajib bila JASA' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  serviceDeadlineDays?: number;

  @ApiPropertyOptional({ description: 'Info pengiriman digital (produk DIGITAL)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  digitalDeliveryInfo?: string;

  @ApiPropertyOptional({ description: 'Jadwal publish (ISO). Kosongkan untuk publish manual.' })
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;
}

// ── Item 6: trending keywords ────────────────────────────────────────────────

export class RecordSearchDto {
  @ApiProperty({ description: 'Kata kunci pencarian (disanitasi, tanpa PII)', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  keyword!: string;
}

// ── Item 9: voucher seller ───────────────────────────────────────────────────

export class CreateSellerVoucherDto {
  @ApiProperty({ description: 'Kode unik voucher (huruf besar otomatis)' })
  @IsString()
  @IsNotEmpty()
  @MinLength(4)
  @MaxLength(24)
  code!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({ enum: VoucherType })
  @IsEnum(VoucherType)
  voucherType!: VoucherType;

  @ApiPropertyOptional({ description: 'Nominal diskon IDR (tipe NOMINAL)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountAmountIdr?: number;

  @ApiPropertyOptional({ description: 'Persen diskon 0-100 (tipe PERSEN)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  discountPercent?: number;

  @ApiPropertyOptional({ description: 'Maksimal potongan IDR (bila persen)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxDiscountAmountIdr?: number;

  @ApiPropertyOptional({ description: 'Kuota total pemakaian' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxUsageTotal?: number;

  @ApiPropertyOptional({ description: 'Maksimal pemakaian per user', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxUsagePerUser?: number;

  @ApiPropertyOptional({ description: 'Minimal belanja IDR' })
  @IsOptional()
  @IsInt()
  @Min(0)
  minOrderValueIdr?: number;

  @ApiProperty({ description: 'Awal masa berlaku (ISO)' })
  @IsDateString()
  validFrom!: string;

  @ApiProperty({ description: 'Akhir masa berlaku (ISO)' })
  @IsDateString()
  validUntil!: string;
}

export class ValidateSellerVoucherDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'Nilai order IDR untuk cek min belanja' })
  @IsInt()
  @Min(0)
  orderValueIdr!: number;

  @ApiProperty({ description: 'ID seller pemilik toko' })
  @IsString()
  @IsNotEmpty()
  sellerId!: string;
}

// ── Item 3: cicilan/DP via milestone ─────────────────────────────────────────

export class CreateInstallmentPlanDto {
  @ApiProperty({ description: 'DP persen 0-90 (0 = tanpa DP, langsung cicilan)' })
  @IsInt()
  @Min(0)
  @Max(90)
  dpPercent!: number;

  @ApiProperty({ description: 'Jumlah cicilan setelah DP (1-12)' })
  @IsInt()
  @Min(1)
  @Max(12)
  installmentCount!: number;

  @ApiPropertyOptional({ description: 'Jarak antar cicilan (hari)', default: 30 })
  @IsOptional()
  @IsInt()
  @Min(7)
  @Max(90)
  intervalDays?: number;

  @ApiPropertyOptional({ description: 'Opt-in eksplisit buyer+seller (wajib true)' })
  @IsOptional()
  @IsBoolean()
  agreed?: boolean;
}

// ── Item 10: booking jasa ────────────────────────────────────────────────────

export class CreateServiceSlotDto {
  @ApiProperty({ description: 'ID showcase produk JASA' })
  @IsString()
  @IsNotEmpty()
  showcaseId!: string;

  @ApiProperty({ description: 'Tanggal slot (YYYY-MM-DD, WIB)' })
  @IsDateString()
  slotDate!: string;

  @ApiProperty({ description: 'Jam mulai HH:mm' })
  @IsString()
  @MaxLength(5)
  startTime!: string;

  @ApiProperty({ description: 'Jam selesai HH:mm' })
  @IsString()
  @MaxLength(5)
  endTime!: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

// ── Item 11: SPK ringan ──────────────────────────────────────────────────────

export class CreateAgreementDto {
  @ApiProperty({ description: 'ID order (publik orderId)' })
  @IsString()
  @IsNotEmpty()
  orderId!: string;

  @ApiProperty({ description: 'Teks kesepakatan', maxLength: 5000 })
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  @MaxLength(5000)
  text!: string;
}

// ── Item 12: digital delivery ────────────────────────────────────────────────

export class CreateDigitalAssetDto {
  @ApiProperty({ description: 'ID showcase produk DIGITAL' })
  @IsString()
  @IsNotEmpty()
  showcaseId!: string;

  @ApiProperty({ enum: DigitalAssetType })
  @IsEnum(DigitalAssetType)
  assetType!: DigitalAssetType;

  @ApiProperty({ description: 'FILE=fileKey upload, LINK=URL, LICENSE=kode lisensi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  payload!: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

// ── Item 13: jastip ──────────────────────────────────────────────────────────

export class CreateJastipTripDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Deadline order (ISO)' })
  @IsDateString()
  orderDeadline!: string;

  @ApiPropertyOptional({ description: 'Batas slot peserta (0 = tanpa batas)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  slotTotal?: number;
}

export class AddJastipItemDto {
  @ApiProperty({ maxLength: 150 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ description: 'Estimasi harga IDR' })
  @IsOptional()
  @IsInt()
  @Min(0)
  estimatedPriceIdr?: number;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class JoinJastipDto {
  @ApiProperty({ description: 'Ringkasan item yang dipesan', maxLength: 300 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  itemSummary!: string;
}

export class LockJastipPriceDto {
  @ApiProperty({ description: 'Harga barang IDR (terkunci)' })
  @IsInt()
  @Min(0)
  goodsAmountIdr!: number;

  @ApiProperty({ description: 'Fee jastip IDR (terkunci, transparan)' })
  @IsInt()
  @Min(0)
  jastipFeeIdr!: number;

  @ApiProperty({ description: 'Ongkir IDR (terkunci, transparan)' })
  @IsInt()
  @Min(0)
  shippingCostIdr!: number;
}

export class LinkJastipOrderDto {
  @ApiProperty({ description: 'orderId publik dari escrow order yang sudah dibayar' })
  @IsString()
  @IsNotEmpty()
  orderId!: string;
}

// ── Item 14: patungan ────────────────────────────────────────────────────────

export class CreatePatunganGroupDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'Target dana IDR' })
  @IsInt()
  @Min(10000)
  @Max(1_000_000_000_000)
  targetAmountIdr!: number;

  @ApiProperty({ description: 'Deadline (ISO)' })
  @IsDateString()
  deadlineAt!: string;

  @ApiPropertyOptional({ description: 'Batas slot peserta (0 = tanpa batas)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  slotTotal?: number;

  @ApiPropertyOptional({ enum: PatunganMode, default: PatunganMode.BAGI_RATA })
  @IsOptional()
  @IsEnum(PatunganMode)
  mode?: PatunganMode;

  @ApiPropertyOptional({ description: 'Nominal per orang IDR (wajib bila BAGI_RATA)' })
  @IsOptional()
  @IsInt()
  @Min(1000)
  perPersonAmountIdr?: number;
}

export class JoinPatunganDto {
  @ApiPropertyOptional({ description: 'Nominal IDR (mode CUSTOM; BAGI_RATA pakai perPersonAmount)' })
  @IsOptional()
  @IsInt()
  @Min(1000)
  amountIdr?: number;

  // LOW (SEC-B ronde 2): orderId DIHAPUS dari DTO join. Penautan order WAJIB
  // lewat POST /participants/:id/link-order yang memvalidasi kepemilikan,
  // seller, nilai, dan status — menerima orderId di join membuka squatting
  // (mengklaim order milik orang lain). Klien yang mengirim orderId kini
  // ditolak ValidationPipe (forbidNonWhitelisted).
}

// SEC-C I1: linkOrder patungan sebelumnya memakai `@Body() body: { orderId: string }`
// literal tanpa validasi — samakan dengan LinkJastipOrderDto (validasi non-empty).
// Wave 3: trim dulu agar orderId berisi spasi saja ikut ditolak (bukan 500 Prisma).
export class LinkPatunganOrderDto {
  @ApiProperty({ description: 'orderId publik dari escrow order yang sudah dibayar' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  orderId!: string;
}

// ── Item 15: banner ──────────────────────────────────────────────────────────

export class CreateBannerDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiProperty({ description: 'URL gambar banner' })
  @IsUrl()
  @MaxLength(500)
  imageUrl!: string;

  @ApiPropertyOptional({ description: 'URL tujuan saat banner diklik' })
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  linkUrl?: string;

  @ApiPropertyOptional({ default: 'home_top' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  position?: string;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Awal tayang (ISO)' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ description: 'Akhir tayang (ISO)' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

export class UpdateBannerDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  linkUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  position?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

export { AgreementStatus };
