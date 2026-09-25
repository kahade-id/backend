import {
  IsString, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';
import { LocationDto } from './location.dto';

const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
const USERNAME_MSG =
  'Username must be 3-30 characters and contain only letters, numbers, dots, and underscores';

/**
 * Registrasi via nomor HP (disederhanakan).
 * Alur: otp-trigger (purpose=register) → user kirim pesan WA → OTP →
 * verify-otp (status new_user) → phone-register dengan tempToken.
 * Password: minimal 8 karakter, tanpa syarat kombinasi.
 * Username opsional — bila kosong, backend generate otomatis.
 */
export class PhoneRegisterDto {
  @ApiProperty({ description: 'Temp token from OTP verification (scope phone_register)' })
  @IsString()
  @IsNotEmpty()
  tempToken!: string;

  @ApiProperty({ description: 'Full name', minLength: 2, maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[^<>]*$/, { message: 'Name must not contain < or > characters' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  fullName!: string;

  @ApiPropertyOptional({ description: 'Username unik (3-30 karakter). Kosongkan untuk generate otomatis.', minLength: 3, maxLength: 30 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  username?: string;

  @ApiProperty({ description: 'Password (min 8 karakter)', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8, { message: 'Password minimal 8 karakter' })
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({ description: 'Referral code (optional)', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  referralCode?: string;

  @ApiProperty({ description: 'Device identifier bound to the phone-verification token', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: LocationDto })
  @IsOptional()
  @Type(() => LocationDto)
  location?: LocationDto;
}
