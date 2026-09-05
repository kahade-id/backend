import { IsString, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Match } from '../../../common/decorators/match.decorator';

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;
const PASSWORD_MSG =
  'Password must contain at least 1 uppercase, 1 lowercase, 1 digit, and 1 special character';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  @MaxLength(72)
  currentPassword!: string;

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

  @ApiProperty({ description: 'Authenticator or backup code when 2FA is enabled', required: false, maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
    message: 'mfaCode must be a six-digit authenticator code or a 10–16 character backup code',
  })
  mfaCode?: string;
}
