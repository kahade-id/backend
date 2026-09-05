import { IsNumber, IsInt, Min, Max, IsString, IsNotEmpty, Matches, Length, IsOptional, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WALLET_MIN_TRANSFER, WALLET_MAX_TRANSFER_PER_TX } from '../../../common/constants/app.constants';

export class TransferDto {
  @ApiProperty({ description: 'Recipient user ID or username' })
  @IsString()
  @IsNotEmpty({ message: 'Recipient is required' })
  recipientId!: string;

  @ApiProperty({ description: 'Transfer amount in IDR', minimum: WALLET_MIN_TRANSFER, maximum: WALLET_MAX_TRANSFER_PER_TX })
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
  @Min(WALLET_MIN_TRANSFER, { message: `Minimum transfer is Rp ${WALLET_MIN_TRANSFER.toLocaleString()}` })
  @Max(WALLET_MAX_TRANSFER_PER_TX, { message: `Maximum transfer is Rp ${WALLET_MAX_TRANSFER_PER_TX.toLocaleString()}` })
  amount!: number;

  @ApiProperty({ description: '6-digit wallet PIN for transfer authorization' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Wallet PIN must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'Wallet PIN must consist of 6 numeric digits' })
  pin!: string;

  @ApiPropertyOptional({ description: 'Optional note for the transfer' })
  @IsOptional()
  @IsString()
  @MaxLength(200, { message: 'Note must be at most 200 characters' })
  note?: string;
}
