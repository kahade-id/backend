import { createHmac } from 'crypto';

/**
 * Helper test untuk membuat signed URL penyimpanan (`GET /v1/upload/s`)
 * dengan bentuk & rumus HMAC yang SAMA seperti produksi
 * (`UploadService.buildSignedDownloadUrl`) — dipakai spec yang perlu
 * mensimulasikan URL lama/kedaluwarsa tanpa mengimpor service penuh.
 *
 * Rumus produksi: `sig = HMAC-SHA256(<secret>, `${key}:${exp}`)` dalam hex.
 */
export interface SignedStorageUrlOptions {
  /** Detik sejak sekarang; negatif = sudah kedaluwarsa. Default 900. */
  expiresInSeconds?: number;
  /** Override secret (mis. untuk kasus sig tidak cocok). Default secret test. */
  secret?: string;
  /** Host pada URL. Default https://api.kahade.id */
  baseUrl?: string;
}

const DEFAULT_SECRET = 'unit-test-storage-signing-secret-0123456789';

export function generateSignedStorageUrl(
  fileKey: string,
  secret: string = DEFAULT_SECRET,
  options: SignedStorageUrlOptions = {},
): string {
  const expiresIn = options.expiresInSeconds ?? 900;
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = createHmac('sha256', options.secret ?? secret)
    .update(`${fileKey}:${exp}`)
    .digest('hex');
  const base = options.baseUrl ?? 'https://api.kahade.id';
  return `${base}/v1/upload/s?key=${encodeURIComponent(fileKey)}&exp=${exp}&sig=${sig}`;
}
