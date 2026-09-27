import { registerAs } from '@nestjs/config';

/**
 * Receipt (struk anti-manipulasi) configuration.
 *
 * Token struk bersifat stateless dan ditandatangani dengan HMAC-SHA256.
 * Secret dibaca dari env khusus RECEIPT_HMAC_SECRET; bila tidak diset,
 * fallback ke JWT_SECRET aplikasi yang sudah ada (fail-closed: boot
 * production/staging melempar error bila keduanya kosong).
 *
 * Tidak ada secret yang di-commit — nilai hanya berasal dari environment.
 */
export const receiptConfig = registerAs('receipt', () => {
  const hmacSecret = process.env.RECEIPT_HMAC_SECRET || process.env.JWT_SECRET || '';
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (['production', 'staging'].includes(nodeEnv) && !hmacSecret) {
    throw new Error(
      'Missing receipt HMAC secret in ' +
        nodeEnv +
        ': set RECEIPT_HMAC_SECRET (dedicated) or JWT_SECRET (fallback).',
    );
  }

  return {
    /** Secret untuk HMAC-SHA256 penandatanganan token struk. */
    hmacSecret,
    /** Base URL publik untuk verifyUrl (tanpa trailing slash). */
    publicBaseUrl: process.env.RECEIPT_PUBLIC_BASE_URL || 'https://api.kahade.id',
    /** Umur maksimum token struk dalam detik (default 2 tahun). */
    ttlSeconds: (() => {
      const raw = process.env.RECEIPT_TTL_SECONDS;
      if (raw !== undefined && raw !== '') {
        const n = Number(raw);
        if (Number.isSafeInteger(n) && n > 0) return n;
      }
      return 2 * 365 * 24 * 3600;
    })(),
  };
});
