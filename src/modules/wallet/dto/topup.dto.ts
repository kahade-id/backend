import { IsNumber, IsInt, Min, Max, IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { PaymentMethod } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WALLET_DAILY_TOPUP_LIMIT } from '../../../common/constants/app.constants';

const TOPUP_PAYMENT_METHODS = Object.values(PaymentMethod).filter(
  (m) => m !== PaymentMethod.KAHADE_WALLET,
) as Exclude<PaymentMethod, 'KAHADE_WALLET'>[];

export class TopupDto {
  @ApiProperty({ description: 'Top-up amount in IDR', minimum: 10000, maximum: WALLET_DAILY_TOPUP_LIMIT })
  @Transform(({ value }) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (!/^\d+$/.test(value.trim())) return NaN;
      return Number(value.trim());
    }
    return value;
  })
  @IsNumber()
  @IsInt({ message: 'amount must be a whole number (no decimals)' })
  @Min(10000, { message: 'Minimum top-up is Rp 10,000' })
  @Max(WALLET_DAILY_TOPUP_LIMIT, { message: `Maximum single top-up is Rp ${WALLET_DAILY_TOPUP_LIMIT.toLocaleString('id-ID')}` })
  amount!: number;

  @ApiProperty({
    enum: TOPUP_PAYMENT_METHODS,
    description: 'Payment method (KAHADE_WALLET not available for top-up)',
  })
  @IsEnum(TOPUP_PAYMENT_METHODS, { message: 'Invalid payment method' })
  method!: Exclude<PaymentMethod, 'KAHADE_WALLET'>;

  @ApiPropertyOptional({ description: 'Card token from Midtrans.js tokenization (required for CREDIT_CARD method)' })
  @IsOptional()
  @IsString()
  cardToken?: string;

  @ApiPropertyOptional({ description: 'TOPUP_BONUS voucher code to apply once the payment settles' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/i, { message: 'voucherCode may contain only A-Z, 0-9, underscore, or hyphen' })
  voucherCode?: string;

  // Deprecated: Mobile previously collected PIN before top-up but backend never verified it.
  // Top-up is secured via payment gateway auth (bank OTP, 3DS). This field is now ignored
  // to remove unnecessary UX friction. Kept optional for backward compatibility.
  @ApiPropertyOptional({ description: 'Deprecated: Wallet PIN is no longer required for top-up (payment gateway secures it). Ignored if sent.', deprecated: true })
  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'Wallet PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin?: string;
}
