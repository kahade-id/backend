import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

/**
 * Audit Auth 2026-10-10 (#BE-56): body `POST /v1/auth/apple/nonce` sebelumnya
 * bertipe bebas `{ deviceId?: string }` tanpa validasi. DTO ini menyeragamkan
 * `deviceId` dengan pola/panjang yang dipakai DTO auth lain.
 */
export class AppleNonceDto {
  @ApiPropertyOptional({ description: 'Device identifier (opsional; mengikat nonce ke perangkat)', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId?: string;
}
