import { BadRequestException } from '@nestjs/common';
import * as ErrorCodes from '../../common/constants/error-codes';

/**
 * AUT-009: kebijakan password ADMIN — satu-satunya sumber kebenaran untuk
 * sisi admin (dipakai create admin, reset password, ganti password).
 *
 * - Admin: min 12 karakter + wajib huruf besar + huruf kecil + angka + simbol.
 * - User mobile: min 8 karakter TANPA syarat kompleksitas — lihat
 *   `src/modules/auth/password-policy.ts` (keputusan produk auth-rework
 *   2026-09-26; kekuatan dijamin rate-limit, lockout progresif, 2FA opsional).
 *
 * Arahnya disengaja (admin lebih ketat karena privilese tinggi). Ini BUKAN
 * keharusan untuk diseragamkan — tetapi bila salah satu sisi diubah,
 * perbarui komentar silang di sisi lain agar pesan error FE vs aturan BE
 * tidak drift.
 */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 72;

const ADMIN_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()\-_=+{};:,<.>/?\\|'"`~[\]@])/;

/**
 * Validasi password admin (dipakai saat pembuatan, reset oleh SUPER_ADMIN,
 * dan ganti password mandiri). Fail-closed: password yang tidak memenuhi
 * syarat ditolak sebelum di-hash.
 */
export function validateAdminPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new BadRequestException({
      code: ErrorCodes.PASSWORD_TOO_WEAK,
      message: `Password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
    });
  }
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw new BadRequestException({
      code: ErrorCodes.PASSWORD_TOO_WEAK,
      message: `Password must be at most ${ADMIN_PASSWORD_MAX_LENGTH} characters`,
    });
  }
  if (!ADMIN_PASSWORD_REGEX.test(password)) {
    throw new BadRequestException({
      code: ErrorCodes.PASSWORD_TOO_WEAK,
      message: 'Password must contain uppercase, lowercase, digit, and special character',
    });
  }
}
