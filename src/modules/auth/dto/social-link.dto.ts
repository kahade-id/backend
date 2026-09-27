import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GAP-A G013: tautkan Google/Apple dari akun yang sedang login.
 * Re-auth wajib: salah satu dari password / otpCode (WhatsApp) / reauthToken,
 * plus mfaCode bila 2FA aktif (lihat AuthService.assertPasskeyReauthenticated).
 */
export class LinkSocialProviderDto {
  @ApiProperty({ description: 'Social provider', enum: ['google', 'apple'] })
  @IsEnum(['google', 'apple'])
  provider!: 'google' | 'apple';

  @ApiProperty({ description: 'ID token dari provider sosial' })
  @IsString()
  @IsNotEmpty()
  idToken!: string;

  @ApiPropertyOptional({ description: 'Nonce Apple (wajib untuk Apple)' })
  @IsOptional()
  @IsString()
  nonce?: string;

  @ApiPropertyOptional({ description: 'Kata sandi untuk re-autentikasi' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: 'Kode TOTP/backup bila 2FA aktif' })
  @IsOptional()
  @IsString()
  mfaCode?: string;

  @ApiPropertyOptional({ description: 'Kode OTP WhatsApp (akun tanpa password)' })
  @IsOptional()
  @IsString()
  otpCode?: string;
}

/**
 * GAP-A G014: konfirmasi penautan setelah konflik email.
 * linkToken sekali-pakai dari respons social-login { requiresLink: true }.
 *
 * KEAMANAN: linkToken TIDAK membawa user id — hanya { provider, providerSub,
 * email }. Pemanggil WAJIB membuktikan kepemilikan akun Kahade lama via
 * re-auth: password (akun berpassword), otpCode (OTP WhatsApp), atau
 * reauthToken — plus mfaCode bila 2FA aktif. Tanpa re-auth valid, penautan
 * ditolak (anti account-takeover).
 */
export class ConfirmSocialLinkDto {
  @ApiProperty({ description: 'Token konfirmasi penautan sekali-pakai' })
  @IsString()
  @IsNotEmpty()
  linkToken!: string;

  @ApiPropertyOptional({ description: 'Kata sandi akun Kahade (re-auth kepemilikan akun)' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: 'Kode TOTP/backup bila 2FA aktif' })
  @IsOptional()
  @IsString()
  mfaCode?: string;

  @ApiPropertyOptional({ description: 'Kode OTP WhatsApp (re-auth akun tanpa password)' })
  @IsOptional()
  @IsString()
  otpCode?: string;

  @ApiPropertyOptional({ description: 'Token re-autentikasi terbaru (scope passkey_reauth)' })
  @IsOptional()
  @IsString()
  reauthToken?: string;

  @ApiPropertyOptional({ description: 'Device ID untuk pelacakan sesi' })
  @IsOptional()
  @IsString()
  deviceId?: string;

  @ApiPropertyOptional({ description: 'Info perangkat (user-agent)' })
  @IsOptional()
  @IsString()
  deviceInfo?: string;
}

/**
 * GAP-A G019: lepas tautan provider. Re-auth wajib; menolak bila ini
 * satu-satunya metode login yang tersisa.
 */
export class UnlinkSocialProviderDto {
  @ApiPropertyOptional({ description: 'Kata sandi untuk re-autentikasi' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: 'Kode TOTP/backup bila 2FA aktif' })
  @IsOptional()
  @IsString()
  mfaCode?: string;

  @ApiPropertyOptional({ description: 'Kode OTP WhatsApp (akun tanpa password)' })
  @IsOptional()
  @IsString()
  otpCode?: string;
}
