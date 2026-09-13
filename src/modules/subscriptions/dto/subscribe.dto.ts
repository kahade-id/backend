import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches, MaxLength, IsDateString } from 'class-validator';
import { Transform } from 'class-transformer';
import { SubscriptionPlan, PaymentMethod } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const toBoolean = ({ value }: { value: unknown }) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return value;
};

export class SubscribeDto {
  @ApiProperty({ enum: SubscriptionPlan, description: 'Subscription plan' })
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  @ApiPropertyOptional({ description: 'Wallet PIN for paid subscription verification. Optional only when useTrial=true.' })
  @IsOptional()
  @IsString()
  @Length(6, 6)
  pin?: string;

  @ApiPropertyOptional({ enum: PaymentMethod, description: 'Payment method' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Active SUBSCRIPTION_DISCOUNT campaign promo code for the first paid period' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Z0-9_-]+$/i, { message: 'promoCode may contain only A-Z, 0-9, underscore, or hyphen' })
  promoCode?: string;

  @ApiPropertyOptional({ description: 'Start the one-lifetime free trial instead of charging wallet balance' })
  @IsOptional()
  @IsBoolean()
  @Transform(toBoolean)
  useTrial?: boolean;
}

export class RenewDto {
  @ApiProperty({ description: 'Wallet PIN for payment verification' })
  @IsString()
  @Length(6, 6)
  pin!: string;
}

export class PauseSubscriptionDto {
  @ApiPropertyOptional({ description: 'Auto-resume date (ISO 8601). If omitted, the subscription stays paused until manual resume.' })
  @IsOptional()
  @IsDateString()
  resumeAt?: string;
}
