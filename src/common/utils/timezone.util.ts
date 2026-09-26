/**
 * CN-008: helper zona waktu untuk quiet hours.
 *
 * Sebelumnya perhitungan jam sepi meng-hardcode WIB (UTC+7) di dua tempat.
 * Sekarang zona waktu diambil dari preferensi user (`quietHoursTimezone`,
 * IANA tz database), dengan fallback ke Asia/Jakarta agar perilaku lama
 * tetap dipertahankan bila field belum diisi.
 */

/** Zona waktu default bila preferensi kosong/invalid: Asia/Jakarta (WIB). */
export const DEFAULT_QUIET_HOURS_TIMEZONE = 'Asia/Jakarta';

/**
 * Validasi ringan: hanya terima string IANA yang dikenali Intl.
 * Mengembalikan canonical timezone atau null bila invalid.
 */
export function normalizeTimezone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return null;
  try {
    // Intl melempar RangeError untuk zona waktu yang tidak dikenal.
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * Menit sejak tengah malam (0-1439) dari `date` di zona waktu `timeZone`.
 * Fallback ke DEFAULT_QUIET_HOURS_TIMEZONE bila timeZone invalid.
 */
export function getMinutesInTimezone(date: Date, timeZone?: string | null): number {
  const tz = normalizeTimezone(timeZone) ?? DEFAULT_QUIET_HOURS_TIMEZONE;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    // hour12:false bisa menghasilkan "24" untuk tengah malam di beberapa ICU.
    const h = hour === 24 ? 0 : hour;
    return h * 60 + minute;
  } catch {
    // Sangat defensif: jangan pernah menggagalkan pengiriman notifikasi.
    const d = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

/**
 * True bila `currentMinutes` berada dalam rentang [start, end).
 * Mendukung rentang overnight (mis. 22:00-07:00).
 */
export function isMinutesInRange(currentMinutes: number, start: string, end: string): boolean {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
  const startMinutes = sh * 60 + sm;
  const endMinutes = eh * 60 + em;
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
