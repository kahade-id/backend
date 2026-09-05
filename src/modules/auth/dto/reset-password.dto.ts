import { IsEmail, IsString, Length, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Match } from '../../../common/decorators/match.decorator';

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG =
  'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Email address', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase().trim() : value))
  email!: string;

  @ApiProperty({ description: 'OTP code (6 digits)', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'otp must contain exactly 6 digits' })
  otp!: string;

  @ApiProperty({ description: 'New password', minLength: 12, maxLength: 72 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Matches(PASSWORD_REGEX, { message: PASSWORD_MSG })
  newPassword!: string;

  @ApiProperty({ description: 'Confirm new password', minLength: 12, maxLength: 72 })
  @IsString()
  @MinLength(12)
  @MaxLength(72)
  @Match('newPassword', { message: 'confirmPassword must match newPassword' })
  confirmPassword!: string;
}
