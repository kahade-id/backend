import { IsString, IsOptional, IsInt, IsIn, Min, Max, MaxLength, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Batch 43 BE-CHAT: buat transaksi escrow 1-by-1 dari chat.
 * Uang HANYA lewat escrow (delegasi ke OrdersService.createOrder) — DILARANG
 * KERAS jalur wallet-to-wallet langsung (keputusan user: DITOLAK).
 */
export class CreateOrderFromChatDto {
  @ApiPropertyOptional({ description: 'ID etalase yang dinegosiasikan (penjual = pemilik etalase)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  showcaseId?: string;

  @ApiPropertyOptional({
    description: 'Judul order (wajib bila tanpa showcaseId)',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional({ description: 'Deskripsi order (wajib bila tanpa showcaseId)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    description: 'Harga sepakati dalam RUPIAH (bila diisi; bila tidak, pakai harga etalase)',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000_000_000)
  hargaSepakat?: number;

  @ApiPropertyOptional({ description: 'Jumlah unit (default 1)', default: 1, minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  qty?: number;

  @ApiPropertyOptional({ description: 'Peran pembuat order', enum: ['BUYER', 'SELLER'], default: 'BUYER' })
  @IsOptional()
  @IsIn(['BUYER', 'SELLER'])
  role?: 'BUYER' | 'SELLER';

  @ApiPropertyOptional({ description: 'Tipe order', enum: ['PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER'], default: 'PHYSICAL_GOODS' })
  @IsOptional()
  @IsIn(['PHYSICAL_GOODS', 'DIGITAL_GOODS', 'SERVICE', 'OTHER'])
  orderType?: 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'SERVICE' | 'OTHER';

  @ApiPropertyOptional({ description: 'Tenggat kirim (hari, 1–14)', default: 3, minimum: 1, maximum: 14 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(14)
  deliveryDeadlineDays?: number;

  @ApiPropertyOptional({ description: 'Siapa menanggung fee', enum: ['BUYER', 'SELLER', 'SPLIT'], default: 'BUYER' })
  @IsOptional()
  @IsIn(['BUYER', 'SELLER', 'SPLIT'])
  feeResponsibility?: 'BUYER' | 'SELLER' | 'SPLIT';
}
