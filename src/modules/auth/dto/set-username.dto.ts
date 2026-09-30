import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// DBL-006 (audit integrasi 2026-10-01): aturan username DISATUKAN dengan
// register.dto.ts / phone-register.dto.ts — 3–30 karakter, charset
// [a-zA-Z0-9._]. DTO ini dulu lebih ketat (3–20, huruf kecil saja, + paksa
// lowercase via @Transform), sehingga user yang daftar dengan username valid
// (kapital/titik, mis. "Ff.Kahade") tidak bisa memakai/mengganti username-nya
// sendiri — endpoint ubah menolak pola yang kemarin diterima saat registrasi.
//
// Uniqueness tetap case-insensitive: auth.service.setUsername menormalkan
// input ke lowercase sebelum findUnique — tanpa memaksa input lowercase di
// DTO (kapital di input diterima, dinormalkan di service seperti register).
const USERNAME_REGEX = /^[a-zA-Z0-9._]+$/;
const USERNAME_MSG =
  'Username must be 3-30 characters and contain only letters, numbers, dots, and underscores';

export class SetUsernameDto {
  @ApiProperty({ description: 'Unique username (3-30 characters)', minLength: 3, maxLength: 30 })
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(USERNAME_REGEX, { message: USERNAME_MSG })
  username!: string;
}
