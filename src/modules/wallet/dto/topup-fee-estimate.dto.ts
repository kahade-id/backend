import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * WF-008: query estimasi fee top-up kanonis (server-side).
 * Client sebelumnya menghitung `amount + fee` sendiri dari spek fee —
 * angka total bisa berbeda dari yang ditagih gateway. Endpoint ini
 * memakai logika fee yang SAMA dengan jalur charge (calculatePaymentFee).
 */
export class TopupFeeEstimateDto {
  @ApiProperty({ description: 'Top-up amount in IDR (whole number)', minimum: 1 })
  @Type(() => Number)
  @Transform(({ value }) => (typeof value === 'string' ? Number(value.trim()) : value))
  @IsInt({ message: 'amount must be a whole number (no decimals)' })
  @Min(1, { message: 'amount must be positive' })
  amount!: number;

  @ApiProperty({ description: 'Payment method id (see GET /v1/wallet/payment-methods)' })
  @IsString()
  @IsNotEmpty()
  method!: string;
}
