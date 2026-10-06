import { IsNumber, IsInt, Min, Max, IsString, IsNotEmpty, IsOptional, Matches, Length, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LocationDto } from '../../auth/dto/location.dto';
import { WALLET_MIN_WITHDRAW, WALLET_MAX_WITHDRAW_PER_TX } from '../../../common/constants/app.constants';
import { formatIdr } from '../../../common/utils/currency.util';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class WithdrawDto {
  // P3: DTO max diselaraskan dengan batas per-transaksi efektif yang dienforce
  // service (WALLET_MAX_WITHDRAW_PER_TX = 25jt). Sebelumnya memakai
  // WALLET_DAILY_WITHDRAW_LIMIT (50jt) sehingga request 25-50jt lolos DTO
  // lalu ditolak service dengan ABOVE_MAXIMUM_WITHDRAW — membingungkan.
  // Daily limit tetap dienforce terpisah oleh service.
  @ApiProperty({ description: 'Withdrawal amount in IDR (per-transaction max)', minimum: WALLET_MIN_WITHDRAW, maximum: WALLET_MAX_WITHDRAW_PER_TX })
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
  @Min(WALLET_MIN_WITHDRAW, { message: `Minimum withdrawal is ${formatIdr(WALLET_MIN_WITHDRAW)}` })
  @Max(WALLET_MAX_WITHDRAW_PER_TX, { message: `Maximum single withdrawal is ${formatIdr(WALLET_MAX_WITHDRAW_PER_TX)}` })
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

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional — null/absent bila user menolak izin GPS)', type: () => LocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  deviceLocation?: LocationDto | null;
}
