import { IsString, IsEnum, IsNumber, IsInt, Min, Max, MinLength, MaxLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WALLET_DAILY_TOPUP_LIMIT } from '../../../../common/constants/app.constants';

export enum WalletAdjustType {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export class WalletAdjustDto {
  @ApiProperty({ description: 'Amount in IDR (whole number; will be converted to sen internally)', minimum: 1, maximum: WALLET_DAILY_TOPUP_LIMIT })
  @IsNumber()
  @IsInt({ message: 'amount must be a whole number (no decimals)' })
  @Min(1)
  @Max(WALLET_DAILY_TOPUP_LIMIT, { message: `Maximum single adjustment is Rp ${WALLET_DAILY_TOPUP_LIMIT.toLocaleString()}` })
  amount!: number;

  @ApiProperty({ enum: WalletAdjustType, description: 'CREDIT to add funds, DEBIT to subtract funds' })
  @IsEnum(WalletAdjustType)
  type!: WalletAdjustType;

  @ApiProperty({ description: 'Reason for the wallet adjustment', minLength: 5, maxLength: 1000 })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({ description: 'Idempotency key to prevent duplicate adjustments (SEC-013)' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  idempotencyKey?: string;
}
