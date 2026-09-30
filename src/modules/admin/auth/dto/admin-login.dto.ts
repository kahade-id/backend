import { IsEmail, IsString, IsNumber, IsOptional, Min, Max, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminLoginDto {
  @ApiProperty({ description: 'Admin email address' })
  @IsEmail()
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  email!: string;

  @ApiProperty({ description: 'Admin password', minLength: 8, maxLength: 72 })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiPropertyOptional({ description: 'TOTP token for 2FA', minLength: 6, maxLength: 6 })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  totpToken?: string;

  // AUT-001: identitas perangkat — diikat ke TempToken 2FA/MFA agar tidak
  // bisa dipakai dari perangkat lain bila bocor.
  @ApiPropertyOptional({ description: 'Device identifier bound to the 2FA/MFA tempToken', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  deviceId?: string;

  // AUT-003: slider captcha (protokol yang sama dengan mobile) — wajib bila
  // backend menjawab 401 CAPTCHA_REQUIRED setelah login gagal berulang.
  @ApiPropertyOptional({ description: 'Captcha challenge id (required when CAPTCHA_REQUIRED)', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  captchaId?: string;

  @ApiPropertyOptional({ description: 'Captcha slider answer X (0-100; required when CAPTCHA_REQUIRED)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  captchaAnswer?: number;
}
