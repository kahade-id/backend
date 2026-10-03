import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO lamaran publik. Semua pesan validasi Bahasa Indonesia.
 *
 * `website` = honeypot anti-bot (field hidden di form). Bila terisi,
 * service menolak dengan 400 BOT_DETECTED.
 */
export class SubmitApplicationDto {
  @ApiProperty({ description: 'ID lowongan yang dilamar' })
  @IsString({ message: 'ID lowongan wajib diisi' })
  postingId!: string;

  @ApiProperty({ example: 'Budi Santoso' })
  @IsString({ message: 'Nama lengkap wajib diisi' })
  @MinLength(3, { message: 'Nama lengkap minimal 3 karakter' })
  @MaxLength(200, { message: 'Nama lengkap maksimal 200 karakter' })
  fullName!: string;

  @ApiProperty({ example: 'budi@example.com' })
  @IsEmail({}, { message: 'Format email tidak valid' })
  @MaxLength(255, { message: 'Email maksimal 255 karakter' })
  email!: string;

  @ApiProperty({ example: '081234567890' })
  @Matches(/^\+?[0-9]{9,16}$/, {
    message: 'Nomor HP harus 9–16 digit (boleh diawali +)',
  })
  phone!: string;

  @ApiPropertyOptional({ description: 'Surat pengantar singkat' })
  @IsOptional()
  @IsString({ message: 'Cover note harus berupa teks' })
  @MaxLength(2000, { message: 'Cover note maksimal 2000 karakter' })
  coverNote?: string;

  @ApiPropertyOptional({ example: 'https://portfolio.example.com' })
  @IsOptional()
  @IsUrl({}, { message: 'URL portofolio tidak valid' })
  @MaxLength(512, { message: 'URL portofolio maksimal 512 karakter' })
  portfolioUrl?: string;

  @ApiProperty({ description: 'fileKey dari POST /v1/careers/upload-cv (one-time, kedaluwarsa 1 jam)' })
  @IsString({ message: 'CV wajib diunggah terlebih dahulu' })
  @MaxLength(512, { message: 'fileKey tidak valid' })
  cvFileKey!: string;

  @ApiPropertyOptional({
    description: 'HONEYPOT anti-bot — harus dikosongkan. Bila terisi → 400 BOT_DETECTED.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  @ApiProperty({ description: 'challengeId dari GET /v1/careers/captcha' })
  @IsString({ message: 'Captcha wajib diselesaikan' })
  captchaId!: string;

  @ApiProperty({ description: 'Jawaban soal captcha (angka)' })
  @IsInt({ message: 'Jawaban captcha harus berupa angka' })
  captchaAnswer!: number;
}
