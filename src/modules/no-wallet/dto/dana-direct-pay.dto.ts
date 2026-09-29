import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Metode bayar DANA direct untuk checkout escrow — BEBAS dipilih buyer,
 * diteruskan apa adanya ke DANA (JANGAN hardcode QRIS saja).
 */
export enum DanaDirectPayKind {
  QRIS = 'QRIS',
  VA = 'VA',
  BALANCE = 'BALANCE',
}

export class DanaDirectPayDto {
  @ApiProperty({
    enum: DanaDirectPayKind,
    description:
      'Metode bayar DANA: QRIS (scan QR), VA (Virtual Account bank — butuh bankCode), ' +
      'BALANCE (saldo DANA buyer)',
  })
  @IsEnum(DanaDirectPayKind)
  payKind!: DanaDirectPayKind;

  @ApiPropertyOptional({
    description: 'Kode bank untuk VA (mis. BCA, BRI, MANDIRI, BNI). Wajib bila payKind=VA.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2,20}$/, { message: 'bankCode harus 2-20 huruf' })
  bankCode?: string;
}
