import { BadRequestException } from '@nestjs/common';
import * as ErrorCodes from '../../common/constants/error-codes';

/**
 * Kebijakan password Kahade (efektif 2026-09):
 * - Minimal 8 karakter, maksimal 72 (batas bcrypt).
 * - TIDAK ada syarat kombinasi huruf besar/kecil/angka/simbol
 *   (keputusan produk: mengurangi friksi, kekuatan dijamin oleh
 *   rate-limit, lockout progresif, dan 2FA opsional).
 * - Menolak password yang masuk daftar umum/bocor (blocklist).
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;

// Daftar password umum yang paling sering dipakai / bocor.
// Perbandingan case-insensitive. Bukan pengganti haveibeenpwned
// k-anonymity, tapi menutup celah terbesar dengan biaya nol.
const COMMON_PASSWORDS = new Set(
  [
    'password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123',
    '123456', '12345678', '123456789', '1234567890', '111111', '000000',
    '123123', 'abc123', '1q2w3e4r', '1qaz2wsx', 'dragon', 'monkey',
    'letmein', 'welcome', 'welcome1', 'admin', 'admin123', 'administrator',
    'kahade', 'kahade123', 'kahade1', 'kawalhak', 'indonesia', 'indonesia1',
    'jakarta', 'jakarta123', 'bandung', 'surabaya', 'rahasia', 'rahasia123',
    'sandi', 'sandi123', 'katasandi', 'bismillah', 'assalamualaikum',
    'sayang', 'cinta', 'anjing', 'bangsat', 'kontol', 'ngentot',
    'iloveyou', 'football', 'baseball', 'superman', 'batman',
    'trustno1', 'master', 'shadow', 'sunshine', 'princess',
    'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '0987654321',
    '0123456789', '1234567', '123456a', 'a123456', 'password12',
  ].map((p) => p.toLowerCase()),
);

export function isCommonPassword(password: string): boolean {
  return COMMON_PASSWORDS.has(password.toLowerCase().trim());
}

export function validatePasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: `Password minimal ${PASSWORD_MIN_LENGTH} karakter`,
    });
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: `Password maksimal ${PASSWORD_MAX_LENGTH} karakter`,
    });
  }
  if (isCommonPassword(password)) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Password terlalu umum. Gunakan kombinasi yang lebih unik.',
    });
  }
}
