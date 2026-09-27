/**
 * courier.config.ts — konfigurasi per provider kurir (G226/G249).
 *
 * ATURAN KERAS: tidak ada kredensial provider nyata di repo. Setiap provider
 * membaca:
 *   COURIER_<CODE>_ENABLED      — "true"/"false" (default false)
 *   COURIER_<CODE>_BASE_URL     — base URL API provider (opsional untuk mock)
 *   COURIER_<CODE>_API_KEY_REF  — NAMA env var yang menyimpan API key
 *                                  (bukan nilainya!)
 *   COURIER_<CODE>_HMAC_SECRET_REF — NAMA env var yang menyimpan secret HMAC
 *                                  webhook (bukan nilainya!)
 *   COURIER_<CODE>_REGIONS      — daftar kode wilayah dipisah koma, "*" = nasional
 *   COURIER_<CODE>_TIMEOUT_MS   — timeout panggil provider (default 8000)
 *
 * Contoh: COURIER_JNE_HMAC_SECRET_REF=JNE_WEBHOOK_SECRET, lalu secret asli
 * hanya ada di JNE_WEBHOOK_SECRET (env server / secret manager).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CourierProviderConfig {
  code: string;
  enabled: boolean;
  baseUrl?: string;
  /** Nama env var berisi API key — nilai secret TIDAK PERNAH dibaca ke log. */
  apiKeyRef?: string;
  /** Nama env var berisi secret HMAC webhook — nilai TIDAK PERNAH dibaca ke log. */
  hmacSecretRef?: string;
  regions: string[];
  timeoutMs: number;
}

/** Kode provider yang dikenal katalog (G227). */
export const KNOWN_COURIER_CODES = [
  'jne',
  'jnt',
  'sicepat',
  'gosend',
  'anteraja',
  'paxel',
  'mock',
] as const;

export type KnownCourierCode = (typeof KNOWN_COURIER_CODES)[number];

/** SLA grace days default per provider bila katalog tidak menyebutkannya. */
export const DEFAULT_SLA_GRACE_DAYS: Record<string, number> = {
  jne: 2,
  jnt: 2,
  sicepat: 2,
  gosend: 1,
  anteraja: 2,
  paxel: 1,
  mock: 2,
};

@Injectable()
export class CourierConfigService {
  constructor(private readonly config: ConfigService) {}

  private envName(code: string, suffix: string): string {
    return `COURIER_${code.toUpperCase()}_${suffix}`;
  }

  getProviderConfig(code: string): CourierProviderConfig {
    const get = (suffix: string) => this.config.get<string>(this.envName(code, suffix));
    const regionsRaw = get('REGIONS') ?? '*';
    return {
      code,
      enabled: (get('ENABLED') ?? 'false').toLowerCase() === 'true',
      baseUrl: get('BASE_URL') || undefined,
      apiKeyRef: get('API_KEY_REF') || undefined,
      hmacSecretRef: get('HMAC_SECRET_REF') || undefined,
      regions: regionsRaw.split(',').map((r) => r.trim()).filter(Boolean),
      timeoutMs: Number.parseInt(get('TIMEOUT_MS') ?? '8000', 10) || 8000,
    };
  }

  /** Mengambil nilai secret HMAC dari env var yang ditunjuk apiKeyRef/hmacSecretRef. */
  resolveSecret(refName: string | undefined): string | undefined {
    if (!refName) return undefined;
    const value = this.config.get<string>(refName);
    return value || undefined;
  }

  getAllProviderConfigs(): CourierProviderConfig[] {
    return KNOWN_COURIER_CODES.map((code) => this.getProviderConfig(code));
  }
}
