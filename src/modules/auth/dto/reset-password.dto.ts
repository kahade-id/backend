import { IsString, IsNotEmpty, IsOptional, MinLength, MaxLength, Matches, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { Match } from '../../../common/decorators/match.decorator';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';
import { LocationDto } from './location.dto';

/**
 * Reset password via OTP WhatsApp: tempToken didapat dari verify-otp
 * dengan status 'password_reset' (scope password_reset).
 * Password: minimal 8 karakter, tanpa syarat kombinasi karakter.
 */
export class ResetPasswordDto {
  @ApiProperty({ description: 'Temp token dari verify-otp (scope password_reset)' })
  @IsString()
  @IsNotEmpty()
  tempToken!: string;

  @ApiProperty({ description: 'Device ID — wajib cocok dengan deviceId saat OTP diverifikasi (binding perangkat)', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  // Audit Auth 2026-10-10 (#BE-22): sebelumnya tanpa batas panjang/pola sama sekali.
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;

  @ApiProperty({ description: 'New password (min 8 karakter)', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8, { message: 'Password minimal 8 karakter' })
  @MaxLength(72)
  newPassword!: string;

  @ApiPropertyOptional({ description: 'Confirm new password (opsional; bila dikirim harus sama)', minLength: 8, maxLength: 72 })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Match('newPassword', { message: 'confirmPassword must match newPassword' })
  confirmPassword?: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional)', type: LocationDto })
  @IsOptional()
  // Audit Auth 2026-10-10 (#BE-23): tanpa @ValidateNested, @Min/@Max LocationDto tidak dijalankan.
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}
