import { IsString, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestAccountDeletionDto {
  // G071: opsional di DTO — akun dengan password TETAP wajib password (service
  // menegakkan), akun tanpa password (sosial/OTP) memakai otpCode WhatsApp.
  @ApiPropertyOptional({ description: 'Current password for verification (required for password accounts)' })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password?: string;

  @ApiPropertyOptional({ description: 'Reason for account deletion', maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @ApiPropertyOptional({ description: 'Authenticator or backup code for users with 2FA enabled', maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, { message: 'MFA code must be a six-digit authenticator code or a 10–16 character backup code' })
  mfaCode?: string;

  @ApiPropertyOptional({ description: 'WhatsApp OTP code for re-auth (passwordless accounts only)', maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  @Matches(/^\d{4,10}$/, { message: 'otpCode must be a numeric verification code' })
  otpCode?: string;
}
