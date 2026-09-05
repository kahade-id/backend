import { IsString, IsNotEmpty, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class Disable2faDto {
  @ApiProperty({ description: 'Current account password', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MaxLength(72)
  password!: string;

  @ApiProperty({ description: 'Six-digit authenticator TOTP code or a 10–16 character backup code', minLength: 6, maxLength: 16 })
  @IsString()
  @Length(6, 16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, { message: 'Enter a six-digit authenticator code or a 10–16 character backup code' })
  code!: string;

  @ApiProperty({ description: 'Email OTP code for verification', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'emailOtpCode must contain exactly 6 digits' })
  emailOtpCode!: string;
}
