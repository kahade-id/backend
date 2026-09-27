import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Jenis record yang bisa diterbitkan struk anti-manipulasinya.
 */
export enum ReceiptKind {
  WALLET_TX = 'WALLET_TX',
  TRANSFER = 'TRANSFER',
  ORDER_PAYMENT = 'ORDER_PAYMENT',
  TOPUP = 'TOPUP',
  WITHDRAWAL = 'WITHDRAWAL',
}

export class CreateReceiptTokenDto {
  @ApiProperty({
    enum: ReceiptKind,
    description: 'Jenis record sumber struk',
    example: ReceiptKind.WALLET_TX,
  })
  @IsEnum(ReceiptKind, { message: 'kind harus salah satu dari: WALLET_TX, TRANSFER, ORDER_PAYMENT, TOPUP, WITHDRAWAL' })
  kind!: ReceiptKind;

  @ApiProperty({
    description: 'ID referensi record (txId/orderId/id/midtransOrderId sesuai kind). Harus milik user yang request.',
    example: 'WLT-20260927-0001',
  })
  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'referenceId hanya boleh berisi huruf, angka, underscore, atau hyphen',
  })
  referenceId!: string;
}
