import { encryptAES, decryptAES, hmacSHA256 } from './crypto.util';
import { Logger } from '@nestjs/common';

const piiLogger = new Logger('decryptPiiSafe');

export function normalizePhoneNumber(phone: string): string {
  const cleaned = phone.replace(/[\s\-.]/g, '');
  if (cleaned.startsWith('0')) {
    return '+62' + cleaned.slice(1);
  }
  if (cleaned.startsWith('62') && !cleaned.startsWith('+62')) {
    return '+' + cleaned;
  }
  return cleaned;
}

export function hashPhoneNumber(phone: string): string {
  return hmacSHA256(phone);
}

export async function encryptPii(value: string): Promise<string> {
  return encryptAES(value);
}

export async function decryptPii(value: string): Promise<string> {
  return decryptAES(value);
}

export async function decryptPiiSafe(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  try {
    return await decryptAES(value);
  } catch (err) {
    // 03-#9: FAIL-CLOSED. Sebelumnya mengembalikan ciphertext mentah sebagai
    // "nilai" — ciphertext bisa tampil sebagai nomor HP di UI/admin, bahkan
    // diteruskan sebagai identitas kanal WhatsApp. Kembalikan null dan log
    // insiden TANPA mengutip nilai PII.
    piiLogger.error(
      `PII decryption failed (returning null, fail-closed): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
