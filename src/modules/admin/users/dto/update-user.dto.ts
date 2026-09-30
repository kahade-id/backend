import { IsEnum, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserAccountType } from '@prisma/client';

/**
 * BAI-071 — update terbatas profil user oleh admin.
 *
 * SENSITIF: hanya field dalam whitelist di bawah yang boleh diubah, dan
 * endpoint dibatasi SUPER_ADMIN + audit wajib (before/after).
 *
 * Whitelist saat ini: `accountType` (PERSONAL|BUSINESS) — jalur koreksi
 * operasional untuk kasus BAI-064 (verifikasi bisnis disetujui untuk akun
 * yang terdaftar PERSONAL). Model `User` tidak punya kolom `role`
 * (UserRole hanya dipakai model lain), jadi whitelist hanya berisi
 * accountType; field lain dikirim → ditolak validasi (forbidNonWhitelisted).
 */
export class UpdateUserDto {
  @ApiPropertyOptional({
    description: 'Tipe akun: PERSONAL atau BUSINESS.',
    enum: ['PERSONAL', 'BUSINESS'],
  })
  @IsOptional()
  @IsEnum(UserAccountType, { message: 'accountType must be PERSONAL or BUSINESS' })
  accountType?: UserAccountType;
}
