import { IsNumber, IsInt, Min, Max, IsString, IsNotEmpty, Matches, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { WALLET_MIN_WITHDRAW, WALLET_DAILY_WITHDRAW_LIMIT } from '../../../common/constants/app.constants';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class WithdrawDto {
  @ApiProperty({ description: 'Withdrawal amount in IDR', minimum: WALLET_MIN_WITHDRAW, maximum: WALLET_DAILY_WITHDRAW_LIMIT })
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
  @Min(WALLET_MIN_WITHDRAW, { message: `Minimum withdrawal is Rp ${WALLET_MIN_WITHDRAW.toLocaleString()}` })
  @Max(WALLET_DAILY_WITHDRAW_LIMIT, { message: `Maximum single withdrawal is Rp ${WALLET_DAILY_WITHDRAW_LIMIT.toLocaleString()}` })
  amount!: number;

  @ApiProperty({ description: 'Bank account ID for withdrawal' })
  @IsValidId({ message: 'bankAccountId must be a valid ID' })
  bankAccountId!: string;

  @ApiProperty({ description: '6-digit wallet PIN for withdrawal authorization' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Wallet PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin!: string;
}
