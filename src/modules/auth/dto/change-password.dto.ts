import { IsString, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Match } from '../../../common/decorators/match.decorator';
import { LocationDto } from './location.dto';

export class ChangePasswordDto {
  @ApiProperty({ description: 'Current password', maxLength: 72 })
  @IsString()
  @IsNotEmpty({ message: 'Current password is required' })
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty({ description: 'New password (min 8 karakter)', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8, { message: 'Password minimal 8 karakter' })
  @MaxLength(72)
  newPassword!: string;

  @ApiProperty({ description: 'Confirm new password', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
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

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: LocationDto })
  @IsOptional()
  @Type(() => LocationDto)
  location?: LocationDto;
}
