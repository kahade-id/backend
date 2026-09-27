/**
 * Kahade — metrik delivery push/email/OTP (G494 audit 2026-09-26).
 *
 * Counter per (channel, provider, status):
 *   channel: push | email | otp
 *   provider: expo | fcm | smtp | fonnte | twilio | mock
 *   status: sent | failed | skipped
 *
 * Diinstrumentasi di:
 *   - push.service.ts (Expo/FCM push) → recordDeliveryMetric('push', provider, …)
 *   - email.processor.ts → recordDeliveryMetric('email', 'smtp', …)
 *   - otp-gateway.service.ts → recordDeliveryMetric('otp', providerName, …)
 *
 * Pola penyimpanan: store di level MODUL (bukan instance), sehingga call-site
 * di modul lain (queue, auth, push) bisa mencatat lewat fungsi polos
 * `recordDeliveryMetric` TANPA injeksi DI dan TANPA risiko dependensi
 * sirkular (QueueModule tidak boleh mengimpor ObservabilityModule).
 * Kelas @Injectable di bawah mendelegasikan ke store yang sama sehingga
 * endpoint admin membaca angka yang identik.
 *
 * Yang diekspos ke admin: agregat + status konfigurasi provider OTP
 * (nama provider + boolean token terkonfigurasi — BUKAN nilai token).
 * Tidak ada payload pesan, nomor tujuan, atau isi email yang disimpan.
 */
import { Injectable } from '@nestjs/common';
import { OpsSettingsService } from '../ops-settings/ops-settings.service';

export type DeliveryChannel = 'push' | 'email' | 'otp' | 'whatsapp';
export type DeliveryStatus = 'sent' | 'failed' | 'skipped';

export interface DeliveryStats {
  channel: DeliveryChannel;
  provider: string;
  sent: number;
  failed: number;
  skipped: number;
  /** Waktu event terakhir (ISO) — null bila belum ada. */
  lastAt: string | null;
}

interface Counter {
  sent: number;
  failed: number;
  skipped: number;
  lastAt: number;
}

/** Store bersama level modul — key `${channel}:${provider}`. */
const counters = new Map<string, Counter>();

/**
 * Catat satu event delivery. Aman dipanggil dari modul mana pun
 * (tanpa DI). Tidak menyimpan PII — hanya counter agregat.
 */
export function recordDeliveryMetric(
  channel: DeliveryChannel,
  provider: string,
  status: DeliveryStatus,
  count = 1,
): void {
  const key = `${channel}:${provider}`;
  let c = counters.get(key);
  if (!c) {
    c = { sent: 0, failed: 0, skipped: 0, lastAt: 0 };
    counters.set(key, c);
  }
  c[status] += Math.max(0, Math.floor(count));
  c.lastAt = Date.now();
}

/** Baca snapshot agregat (untuk endpoint admin). */
export function getDeliveryStats(): DeliveryStats[] {
  const out: DeliveryStats[] = [];
  for (const [key, c] of counters) {
    const [channel, provider] = key.split(':') as [DeliveryChannel, string];
    out.push({
      channel, provider,
      sent: c.sent, failed: c.failed, skipped: c.skipped,
      lastAt: c.lastAt ? new Date(c.lastAt).toISOString() : null,
    });
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel) || a.provider.localeCompare(b.provider));
}

@Injectable()
export class DeliveryMetricsService {
  constructor(private readonly opsSettings: OpsSettingsService) {}

  record(channel: DeliveryChannel, provider: string, status: DeliveryStatus): void {
    recordDeliveryMetric(channel, provider, status);
  }

  getStats(): DeliveryStats[] {
    return getDeliveryStats();
  }

  /** Status konfigurasi provider OTP (tanpa kredensial) — untuk halaman admin. */
  getOtpProviderStatus(): { provider: string; tokenConfigured: boolean; production: boolean } {
    const provider = (process.env.OTP_PROVIDER || 'mock').toLowerCase();
    const tokenConfigured =
      provider === 'fonnte' ? this.opsSettings.has('FONNTE_API_TOKEN')
      : provider === 'twilio' ? !!process.env.TWILIO_AUTH_TOKEN
      : true;
    return { provider, tokenConfigured, production: (process.env.NODE_ENV || 'development') === 'production' };
  }
}
