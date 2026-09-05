import { IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { SubscriptionPlan, PaymentMethod } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SubscribeDto {
  @ApiProperty({ enum: SubscriptionPlan, description: 'Subscription plan' })
  @IsEnum(SubscriptionPlan)
  plan!: SubscriptionPlan;

  @ApiProperty({ description: 'Wallet PIN for payment verification' })
  @IsString()
  @Length(6, 6)
  pin!: string;

  @ApiPropertyOptional({ enum: PaymentMethod, description: 'Payment method' })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;
}

export class RenewDto {
  @ApiProperty({ description: 'Wallet PIN for payment verification' })
  @IsString()
  @Length(6, 6)
  pin!: string;
}
