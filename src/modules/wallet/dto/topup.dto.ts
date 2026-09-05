import { IsNumber, IsInt, Min, Max, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
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

  // Mobile sends this and has always collected it before /wallet/topup, but the
  // backend service never verified it (top-up already requires payment-gateway auth:
  // bank OTP, 3DS, etc). Declaring it optional unbreaks the flow (forbidNonWhitelisted
  // was rejecting every request) without adding unnecessary friction. Ideal fix: remove
  // the PIN prompt from mobile — top-up doesn't need double-auth when the gateway
  // already authenticated the payment.
  @ApiPropertyOptional({ description: 'Wallet PIN (6 digits) — collected by mobile but not verified for top-up' })
  @IsOptional()
  @IsString()
  @Length(6, 6, { message: 'Wallet PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin?: string;
}
