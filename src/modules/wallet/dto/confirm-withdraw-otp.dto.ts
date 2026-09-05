import { IsString, IsNotEmpty, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class ConfirmWithdrawOtpDto {
  @ApiProperty({ description: 'Transaction ID' })
  @IsValidId()
  txId!: string;

  @ApiProperty({ description: 'OTP code (6 digits)', minLength: 6, maxLength: 6 })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'OTP must be exactly 6 digits' })
  @Matches(/^\d{6}$/, { message: 'OTP must contain only numeric digits' })
  otp!: string;
}
