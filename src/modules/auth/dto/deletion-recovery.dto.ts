import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GAP-A — DTO alur status & pembatalan penghapusan akun pra-login.
 * Identifier: nomor HP ATAU email (salah satu wajib — dicek di service agar
 * pesan error konsisten).
 */
export class DeletionStatusRequestDto {
  @ApiPropertyOptional({ description: 'Nomor HP Indonesia terdaftar', maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional({ description: 'Email terdaftar', maxLength: 254 })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

export class DeletionStatusVerifyDto extends DeletionStatusRequestDto {
  @ApiPropertyOptional({ description: 'Kode OTP 6 digit dari WhatsApp', maxLength: 10 })
  @IsString()
  @Matches(/^\d{4,10}$/, { message: 'otp must be a numeric verification code' })
  @MaxLength(10)
  otp!: string;
}

export class DeletionCancelDto {
  @ApiPropertyOptional({ description: 'Deletion token sekali-pakai dari status/verify (TTL 15 menit)' })
  @IsString()
  @MaxLength(2048)
  deletionToken!: string;

  @ApiPropertyOptional({ description: 'Alasan pembatalan (opsional)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}
