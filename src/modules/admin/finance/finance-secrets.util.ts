/**
 * E3 (G326-G350) — util masking untuk respons admin finance.
 *
 * Prinsip: respons detail transaksi boleh memuat referensi eksternal provider
 * (order id, VA, dsb.) tetapi TIDAK BOLEH membocorkan secret provider
 * (server key, signature, token sensitif, dsb.) yang kadang terselip di
 * `metadata` / `webhookPayload` mentah.
 *
 * Aturan:
 * - Kunci yang cocok pola SECRET_KEY_PATTERN / TOKEN_KEY_PATTERN → nilainya
 *   di-mask (`****` + 4 karakter terakhir bila string panjang, untuk korelasi).
 * - Rekursif untuk object/array bersarang (maks. kedalaman 6).
 * - `toInitials` dipakai ekspor laporan rekonsiliasi: identitas pengguna
 *   hanya tampil sebagai inisial (tanpa userId/email/nomor).
 */

const SECRET_KEY_PATTERN =
  /(secret|passwd|password|private[-_ ]?key|api[-_ ]?key|server[-_ ]?key|auth[-_ ]?(token|code)|access[-_ ]?token|refresh[-_ ]?token|signature|authorization|set-cookie|cookie|session[-_ ]?(id|token)|otp|pin)/i;

const TOKEN_KEY_PATTERN =
  /(token|snap[-_ ]?token|client[-_ ]?key|secret[-_ ]?key)$/i;

const MAX_DEPTH = 6;

export function maskSecretValue(value: unknown): unknown {
  if (typeof value !== 'string') return '****';
  if (value.length <= 8) return '****';
  return `****${value.slice(-4)}`;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || TOKEN_KEY_PATTERN.test(key);
}

export function maskSecretsDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => maskSecretsDeep(v, depth + 1)) as unknown as T;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? maskSecretValue(v) : maskSecretsDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

/**
 * Inisial dari nama lengkap untuk ekspor tanpa PII.
 * "Budi Santoso" → "BS". Tanpa nama → "??".
 */
export function toInitials(fullName?: string | null): string {
  if (!fullName || !fullName.trim()) return '??';
  const parts = fullName.trim().split(/\s+/);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1]?.charAt(0) ?? '' : '';
  return `${first}${last}`.toUpperCase() || '??';
}
