import { registerAs } from '@nestjs/config';

// Batch 1A (ST-010): R2 adalah legacy yang sudah dibuang dari jalur upload
// (keputusan produk 2026-09-26: storage self-hosted, tanpa spend Cloudflare).
// Konfigurasi ini TIDAK BOLEH menggagalkan boot — sebelumnya melempar FATAL
// bila env R2 tidak diset, bertentangan dengan keputusan "buang R2".
// Nilai kosong = R2 tidak tersedia; pemanggil harus menangani secara eksplisit.

let warnedOnce = false;
function optionalR2(key: string): string {
  const val = process.env[key];
  if (!val || val.trim() === '') {
    if (!warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[r2.config] ${key} is not set — R2 storage is unavailable (self-hosted storage is used instead).`);
    }
    return '';
  }
  return val;
}

export const r2Config = registerAs('r2', () => {
  const accessKeyId = optionalR2('R2_ACCESS_KEY_ID');
  const secretAccessKey = optionalR2('R2_SECRET_ACCESS_KEY');
  const accountId = optionalR2('R2_ACCOUNT_ID');

  const endpointUrl = accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : undefined;

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketPublic: optionalR2('R2_BUCKET_PUBLIC'),
    bucketPrivate: optionalR2('R2_BUCKET_PRIVATE'),
    publicUrl: optionalR2('R2_PUBLIC_URL'),
    presignExpires: parseInt(process.env.R2_PRESIGN_EXPIRES || '900', 10),
    endpointUrl,
  };
});
