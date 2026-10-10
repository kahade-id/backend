import { IsString, IsNotEmpty, IsOptional, MaxLength, MinLength, IsIn, IsObject, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { DEVICE_ID_MESSAGE, DEVICE_ID_PATTERN, normalizeDeviceId } from './device-id.validation';

/**
 * DTO re-auth untuk operasi sensitif passkey (G027, G036, G037).
 * Salah satu bukti re-auth wajib diisi — validasi silang dilakukan di
 * AuthService.assertPasskeyReauthenticated (password bila ada, OTP WhatsApp
 * bila akun social-only, TOTP bila 2FA aktif, atau reauthToken dari /recover).
 */
export class PasskeyReauthDto {
  @ApiPropertyOptional({ description: 'Kata sandi akun (wajib bila akun punya password)', maxLength: 72 })
  @IsOptional()
  @IsString()
  @MaxLength(72)
  password?: string;

  @ApiPropertyOptional({ description: 'Kode TOTP/backup bila 2FA aktif', maxLength: 16 })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  mfaCode?: string;

  @ApiPropertyOptional({ description: 'Kode OTP WhatsApp (untuk akun tanpa password)', maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  otpCode?: string;

  @ApiPropertyOptional({ description: 'Token re-auth sementara dari POST /v1/auth/passkey/recover (step verify)' })
  @IsOptional()
  @IsString()
  reauthToken?: string;
}

export class PasskeyRegisterOptionsDto extends PasskeyReauthDto {
  @ApiPropertyOptional({ description: 'Nama perangkat untuk passkey baru (maks 100 karakter)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

export class PasskeyRegisterVerifyDto {
  @ApiProperty({ description: 'ID tantangan dari /register/options' })
  @IsString()
  @IsNotEmpty()
  challengeId!: string;

  @ApiProperty({ description: 'Attestation response dari navigator.credentials.create() (RegistrationResponseJSON)' })
  @IsObject()
  attestation!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Nama perangkat (maks 100 karakter)', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

export class PasskeyAuthOptionsDto {
  // Audit Auth 2026-10-10 (#BE-41): identifier hanya mengikat challenge ke akun
  // (dicocokkan saat verify) — respons TIDAK lagi memuat allowCredentials.
  @ApiPropertyOptional({ description: 'Username/email/nomor HP (opsional; mengikat tantangan ke akun itu, respons tetap seragam)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  username?: string;
}

export class PasskeyAuthVerifyDto {
  @ApiProperty({ description: 'ID tantangan dari /auth/options' })
  @IsString()
  @IsNotEmpty()
  challengeId!: string;

  @ApiProperty({ description: 'Assertion response dari navigator.credentials.get() (AuthenticationResponseJSON)' })
  @IsObject()
  assertion!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'ID perangkat (diisi otomatis dari session klien bila tersedia)', maxLength: 255 })
  @IsOptional()
  @IsString()
  // Audit Auth 2026-10-10 (#BE-22): pola & panjang deviceId disamakan dengan DTO auth lain.
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Info perangkat' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  deviceInfo?: string;
}

export class PasskeyRenameDto extends PasskeyReauthDto {
  @ApiProperty({ description: 'Nama perangkat baru (maks 100 karakter)', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  deviceName!: string;
}

/** Re-auth untuk revoke dikirim via body DELETE (didokumentasikan di controller). */
export class PasskeyRevokeDto extends PasskeyReauthDto {}

export class PasskeyRecoverDto {
  @ApiProperty({ description: "Langkah: 'request' (kirim OTP) atau 'verify' (verifikasi OTP)", enum: ['request', 'verify'] })
  @IsString()
  @IsIn(['request', 'verify'])
  step!: 'request' | 'verify';

  @ApiPropertyOptional({ description: 'Kode OTP 6 digit dari WhatsApp (wajib untuk step verify)', maxLength: 10 })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  otpCode?: string;

  @ApiPropertyOptional({ description: 'ID perangkat pemohon (untuk deteksi perangkat baru)', maxLength: 255 })
  @IsOptional()
  @IsString()
  // Audit Auth 2026-10-10 (#BE-22): pola & panjang deviceId disamakan dengan DTO auth lain.
  @MaxLength(255)
  @Matches(DEVICE_ID_PATTERN, { message: DEVICE_ID_MESSAGE })
  @Transform(({ value }: { value: unknown }) => normalizeDeviceId(value))
  deviceId?: string;
}
