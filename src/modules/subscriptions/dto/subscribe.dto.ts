import {
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  IsDateString,
} from 'class-validator';
import { SubscriptionPlan, PaymentMethod } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubscribeDto {
  @ApiProperty({ enum: SubscriptionPlan, description: 'Subscription plan' })
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  @ApiPropertyOptional({
    description: 'Wallet PIN for paid subscription verification. Not needed for free promo-code subscriptions.',
  })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin?: string;

  @ApiPropertyOptional({ enum: PaymentMethod, description: 'Payment method' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({
    description: 'Kode promo: kode GRATIS dari admin (durasi ditentukan admin) atau kode campaign SUBSCRIPTION_DISCOUNT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Z0-9_-]+$/i, {
    message: 'promoCode may contain only A-Z, 0-9, underscore, or hyphen',
  })
  promoCode?: string;
}

export class RenewDto {
  @ApiProperty({ description: 'Wallet PIN for payment verification' })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin!: string;
}

export class PauseSubscriptionDto {
  @ApiPropertyOptional({
    description:
      'Auto-resume date (ISO 8601). If omitted, the subscription stays paused until manual resume.',
  })
  @IsOptional()
  @IsDateString()
  resumeAt?: string;
}

import { DanaDirectPayKind } from '../../no-wallet/dto/dana-direct-pay.dto';

export class SubscribeDanaDto {
  @ApiProperty({ enum: SubscriptionPlan, description: 'Subscription plan' })
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  @ApiProperty({
    enum: DanaDirectPayKind,
    description: 'Metode bayar DANA: QRIS | VA | BALANCE (jangan hardcode — tampilkan daftar dari payment-methods)',
  })
  @IsEnum(DanaDirectPayKind)
  payKind!: DanaDirectPayKind;

  @ApiPropertyOptional({ description: 'Kode bank untuk VA: BCA | BNI | BRI | MANDIRI | CIMB | PERMATA' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  bankCode?: string;

  @ApiPropertyOptional({
    description: 'Kode promo: kode GRATIS dari admin atau kode campaign SUBSCRIPTION_DISCOUNT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Z0-9_-]+$/i, {
    message: 'promoCode may contain only A-Z, 0-9, underscore, or hyphen',
  })
  promoCode?: string;
}

export class RenewDanaDto {
  @ApiProperty({
    enum: DanaDirectPayKind,
    description: 'Metode bayar DANA: QRIS | VA | BALANCE',
  })
  @IsEnum(DanaDirectPayKind)
  payKind!: DanaDirectPayKind;

  @ApiPropertyOptional({ description: 'Kode bank untuk VA: BCA | BNI | BRI | MANDIRI | CIMB | PERMATA' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  bankCode?: string;
}
