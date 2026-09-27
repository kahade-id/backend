import { IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LocationDto } from './location.dto';

export class RequestPhoneChangeDto {
  @IsString()
  @MaxLength(20)
  newPhoneNumber!: string;

  // OTP hanya via WhatsApp (kebijakan produk) — Fonnte tidak mendukung SMS.
  // Field `method` sengaja dihapus: tidak ada pilihan metode lagi.

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  currentPassword!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  @Matches(/^(?:\d{6}|[A-Za-z0-9]{10,16})$/, {
    message: 'mfaCode must be a six-digit authenticator code or a 10–16 character backup code',
  })
  mfaCode?: string;
}

export class ConfirmPhoneChangeDto {
  @IsString()
  @MaxLength(20)
  newPhoneNumber!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;

  @ApiPropertyOptional({ description: 'Lokasi presisi perangkat (opsional — null/absent bila user menolak izin GPS)', type: () => LocationDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationDto)
  deviceLocation?: LocationDto | null;
}
