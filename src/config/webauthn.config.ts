import { registerAs } from '@nestjs/config';

/**
 * Konfigurasi WebAuthn/passkey (GAP-A: G032, G044).
 *
 * - WEBAUTHN_RP_ID: RP ID = domain tempat kredensial berlaku. HARUS berupa
 *   host origin halaman web yang memanggil navigator.credentials ATAU
 *   domain induknya (mis. halaman di https://kahade.id memakai rpId
 *   "kahade.id"). "api.kahade.id" TIDAK valid untuk origin kahade.id karena
 *   RP ID tidak boleh subdomain dari host origin.
 * - WEBAUTHN_ORIGINS: daftar origin halaman yang diizinkan, dipisah koma.
 *   Origin yang tidak ada di daftar DITOLAK saat verifikasi (G032).
 * - PASSKEY_REQUIRED_FOR: daftar aksi berisiko yang mewajibkan passkey /
 *   re-auth kuat, dipisah koma (G044). Dibaca oleh guard kebijakan.
 */
function parseList(raw: string | undefined, fallback: string[]): string[] {
  const source = raw === undefined || raw.trim() === '' ? fallback : raw.split(',');
  return source.map(s => s.trim()).filter(Boolean);
}

function defaultRpId(): string {
  const nodeEnv = process.env.NODE_ENV || 'development';
  // G032: RP ID produksi = kahade.id (domain aplikasi web), BUKAN
  // api.kahade.id — RP ID harus sama dengan host origin atau domain
  // induknya; subdomain tidak valid untuk origin https://kahade.id.
  if (nodeEnv === 'production') return 'kahade.id';
  // Audit Auth 2026-10-10 (#BE-48): default staging harus konsisten dengan
  // origin default staging (https://staging.kahade.id) — sebelumnya 'localhost'
  // sehingga semua upacara passkey di staging gagal verifikasi RP ID.
  if (nodeEnv === 'staging') return 'staging.kahade.id';
  return 'localhost';
}

function defaultOrigins(): string[] {
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'production') return ['https://kahade.id', 'https://www.kahade.id'];
  if (nodeEnv === 'staging') return ['https://staging.kahade.id'];
  // Expo web dev server & web build lokal.
  return ['http://localhost:8081', 'http://localhost:19006', 'http://localhost:3000'];
}

export const webauthnConfig = registerAs('webauthn', () => ({
  rpId: (process.env.WEBAUTHN_RP_ID || '').trim() || defaultRpId(),
  rpName: process.env.WEBAUTHN_RP_NAME || 'Kahade',
  origins: parseList(process.env.WEBAUTHN_ORIGINS, defaultOrigins()),
  challengeTtlSeconds: (() => {
    const v = parseInt(process.env.WEBAUTHN_CHALLENGE_TTL_SECONDS || '300', 10);
    return Number.isFinite(v) && v > 0 ? v : 300;
  })(),
  maxPerUser: (() => {
    const v = parseInt(process.env.PASSKEY_MAX_PER_USER || '10', 10);
    return Number.isFinite(v) && v > 0 ? v : 10;
  })(),
  requiredFor: parseList(
    process.env.PASSKEY_REQUIRED_FOR,
    ['bank_account_change', 'security_change'],
  ),
}));
