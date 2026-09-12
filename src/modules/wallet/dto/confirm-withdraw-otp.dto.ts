import { IsString, IsNotEmpty, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsValidId } from '../../../common/decorators/is-valid-id.decorator';

export class ConfirmWithdrawOtpDto {
  @ApiProperty({ description: 'Transaction ID' })
  @IsValidId()
  txId!: string;

  @ApiProperty({ description: 'OTP code (6 digits by default; up to 10 when WITHDRAW_OTP_DIGITS is raised)', minLength: 6, maxLength: 10 })
  @IsString()
  @IsNotEmpty()
  // AUDIT-12: server can issue 6–10 digit withdrawal codes (app.withdrawOtpDigits);
  // accepting the wider range here keeps the API forward-compatible with longer codes
  // while verification remains hash-comparison based.
  @Length(6, 10, { message: 'OTP must be 6–10 digits' })
  @Matches(/^\d{6,10}$/, { message: 'OTP must contain only numeric digits' })
  otp!: string;
}
