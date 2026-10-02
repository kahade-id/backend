/**
 * SYS-B-503 — sanitisasi error mentah provider (DANA) sebelum disimpan ke DB
 * (`lastError`) atau diekspos ke user/log.
 *
 * Pola SEC-204: yang disimpan ke kolom DB plaintext / dikembalikan ke user
 * hanyalah KODE GENERIK yang stabil dan kasar (coarse). Detail mentah
 * provider — yang kerap meng-echo nomor rekening beneficiary di
 * `responseMessage` — hanya boleh ke log internal, itu pun dengan nomor
 * rekening teredaksi.
 *
 * Klasifikasi sengaja hanya level transport (timeout / network / generik):
 * tidak membedakan pesan bisnis provider agar tidak menjadi oracle
 * (pelajaran SEC-204) dan tidak membocorkan PII lewat kode yang dapat
 * dibedakan.
 */

export interface SanitizedProviderError {
  /** Kode generik stabil — aman disimpan ke `lastError` & diekspos ke user. */
  code: string;
  /** Detail untuk log internal — nomor rekening (digit 8+) teredaksi. */
  detailForLog: string;
}

/**
 * Nomor rekening bank Indonesia = rangkaian digit 8+ (rekening 8–16 digit,
 * nomor VA, dsb.). Pola sesuai SYS-B-503: digit 8+ → '****'.
 */
const ACCOUNT_NUMBER_PATTERN = /\d{8,}/g;

/** Redaksi nomor rekening dari teks bebas. */
export function redactAccountNumbers(text: string): string {
  return text.replace(ACCOUNT_NUMBER_PATTERN, '****');
}

const TIMEOUT_PATTERN = /timeout|timed out|etimedout|econnaborted/i;
const NETWORK_PATTERN = /econnrefused|enotfound|eai_again|econnreset|socket hang up|network unreachable|dns/i;

/**
 * Ubah error (atau pesan mentah provider) menjadi { code, detailForLog }.
 *
 * - `code`: salah satu dari PROVIDER_TIMEOUT | PROVIDER_NETWORK_ERROR |
 *   PROVIDER_REQUEST_FAILED — aman untuk kolom DB `lastError` dan respons user.
 * - `detailForLog`: pesan asli dengan nomor rekening teredaksi — hanya untuk
 *   log internal, TIDAK PERNAH ke DB/user.
 */
export function sanitizeProviderError(e: unknown): SanitizedProviderError {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  let code = 'PROVIDER_REQUEST_FAILED';
  if (TIMEOUT_PATTERN.test(raw)) {
    code = 'PROVIDER_TIMEOUT';
  } else if (NETWORK_PATTERN.test(raw)) {
    code = 'PROVIDER_NETWORK_ERROR';
  }
  return {
    code,
    detailForLog: redactAccountNumbers(raw).slice(0, 2000),
  };
}
