import { BadRequestException } from '@nestjs/common';
import * as ErrorCodes from '../../common/constants/error-codes';

const STRICT_INDONESIAN_PHONE = /^(\+62|62|0)8[1-9][0-9]{7,10}$/;

/**
 * Normalisasi nomor HP Indonesia ke format +62....
 * Melempar BadRequestException bila format tidak valid.
 */
export function normalizeIndonesianPhone(phone: string): string {
  const cleaned = phone.replace(/[\s\-.]/g, '');
  if (!STRICT_INDONESIAN_PHONE.test(cleaned)) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Only valid Indonesian mobile numbers are accepted (e.g. 08xx or +628xx)',
    });
  }
  if (cleaned.startsWith('0')) {
    return '+62' + cleaned.slice(1);
  }
  if (cleaned.startsWith('62')) {
    return '+' + cleaned;
  }
  return cleaned;
}

/**
 * Normalisasi longgar untuk nomor pengirim webhook WhatsApp
 * (Fonnte mengirim digit saja, kadang tanpa kode negara).
 * Tidak melempar — kembalikan null bila tidak dikenali.
 */
export function normalizeSenderPhoneLoose(sender: string): string | null {
  const digits = sender.replace(/\D/g, '');
  if (/^08[1-9][0-9]{7,10}$/.test(digits)) return '+62' + digits.slice(1);
  if (/^628[1-9][0-9]{7,10}$/.test(digits)) return '+' + digits;
  return null;
}

/** Samakan dua nomor yang sudah dinormalisasi longgar/ketat. */
export function samePhoneNumber(a: string, b: string): boolean {
  const na = a.replace(/\D/g, '').replace(/^0/, '62');
  const nb = b.replace(/\D/g, '').replace(/^0/, '62');
  return na === nb && na.length >= 10;
}
