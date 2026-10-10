import { IsString, IsNotEmpty, MaxLength, Length, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

export class Verify2faLoginDto {
  @ApiProperty({ description: 'Temporary token from login', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  tempToken!: string;

  @ApiProperty({ description: 'Six-digit TOTP code or 10–16 character backup code', minLength: 6, maxLength: 16 })
  @IsString()
  @Length(6, 16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
    message: 'code must be a six-digit authenticator code or a 10–16 character backup code',
  })
  code!: string;

  @ApiProperty({ description: 'Device identifier', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  // Audit Auth 2026-10-10 (#BE-22): pola & panjang deviceId disamakan dengan DTO OTP.
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Device information', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  deviceInfo?: string;
}
