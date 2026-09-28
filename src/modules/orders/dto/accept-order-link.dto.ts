import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * TRX-009 — body opsional untuk `POST /v1/orders/links/:token/accept`.
 *
 * Untuk order link PHYSICAL_GOODS yang dibuat dengan peran SELLER, penerima
 * (yang menjadi BUYER) WAJIB menyertakan `shippingAddressId` dari buku
 * alamat miliknya — backend fail-closed (SHIPPING_ADDRESS_REQUIRED) dan
 * me-snapshot alamat terenkripsi ke order, sama seperti jalur createOrder.
 * Untuk link yang dibuat dengan peran BUYER, alamat sudah ada di link
 * (diisi pembuat saat create link) sehingga field ini diabaikan.
 */
export class AcceptOrderLinkDto {
  @ApiPropertyOptional({
    description:
      'ID alamat pengiriman dari buku alamat milik penerima (pembeli). ' +
      'Wajib untuk link PHYSICAL_GOODS yang dibuat dengan peran SELLER.',
    maxLength: 100,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  shippingAddressId?: string;
}
