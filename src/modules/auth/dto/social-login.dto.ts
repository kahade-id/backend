import { IsString, IsNotEmpty, IsOptional, IsEnum, ValidateNested, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { LocationDto } from './location.dto';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

export class SocialLoginDto {
  @ApiProperty({ description: 'Social provider', enum: ['google', 'apple'] })
  @IsEnum(['google', 'apple'])
  provider!: 'google' | 'apple';

  @ApiProperty({ description: 'ID token from social provider (Google ID token or Apple identityToken)' })
  @IsString()
  @IsNotEmpty()
  idToken!: string;

  // Audit Auth 2026-10-10 (#BE-30): deviceId WAJIB — tempToken 2FA & sesi
  // sosial sebelumnya memakai fallback literal 'social' sehingga sesi antar
  // perangkat saling mengusir dan binding perangkat tidak berarti.
  @ApiProperty({ description: 'Device ID for session tracking', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @MaxLength(255)
  deviceId!: string;

  @ApiPropertyOptional({ description: 'Device info (user-agent)' })
  @IsOptional()
  @IsString()
  deviceInfo?: string;

  @ApiPropertyOptional({ description: 'WAJIB untuk Apple: nonce yang diterbitkan server via POST /v1/auth/apple/nonce (sekali pakai, TTL 600 dtk). Nonce buatan klien ditolak.' })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiPropertyOptional({ description: 'Access token (required for Apple to verify)' })
  @IsOptional()
  @IsString()
  accessToken?: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional; konsisten dengan LoginDto)' })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  location?: LocationDto;
}
