/**
 * GAP-E (G276–G300): utilitas perhitungan SLA operasional antrean KYC.
 *
 * Dua mode jam SLA:
 * - jam kalender: elapsed = now - slaStartedAt (wall clock).
 * - jam kerja: hanya Senin–Jumat 09:00–17:00 WIB (Asia/Jakarta, UTC+7, tanpa DST)
 *   yang dihitung; malam/weekend tidak menggerus SLA.
 *
 * Jeda (pause): saat admin meminta dokumen tambahan, slaPausedAt di-set. Saat
 * dokumen dilengkapi, jeda diakumulasikan ke slaPausedAccumMs (dalam satuan
 * "jam SLA" yang sama dengan mode aktif) lalu slaPausedAt di-null-kan.
 *
 * Rumus umur SLA: clock(slaStartedAt, now) - slaPausedAccumMs
 * dengan clock = jam kalender atau jam kerja sesuai config.
 */

export type SlaStatus = 'OK' | 'MENDEKATI' | 'BREACHED';

/** Ambang "mendekati": sisa < 20% dari total jam SLA. */
export const SLA_WARNING_REMAINING_RATIO = 0.2;

/** Scope SLA operasional yang dikenal. */
export const SLA_SCOPES = ['KYC_PERSONAL', 'BUSINESS_VERIFICATION'] as const;
export type SlaScope = (typeof SLA_SCOPES)[number];

/** Default saat config belum pernah dibaca: 48 jam kalender. */
export const DEFAULT_SLA_HOURS = 48;

export interface SlaConfigLike {
  slaHours: number;
  useBusinessHours: boolean;
}

export interface SlaTrackable {
  slaStartedAt: Date | null | undefined;
  slaPausedAt: Date | null | undefined;
  /** BigInt dari Prisma — diterima sebagai number|bigint|string. */
  slaPausedAccumMs: bigint | number | string | null | undefined;
}

/** WIB = UTC+7 tetap (tidak ada DST). */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const BUSINESS_START_HOUR_WIB = 9;
const BUSINESS_END_HOUR_WIB = 17;

function toMs(value: bigint | number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Millisecond "jam kerja" antara dua instant: irisan [start, end) dengan
 * jendela Senin–Jumat 09:00–17:00 WIB.
 */
export function businessMsBetween(start: Date, end: Date): number {
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;

  let total = 0;
  // Iterasi per hari kalender WIB: mulai dari hari WIB yang memuat `start`.
  let cursorDayStartUtc = dayStartUtcOfWibDay(startMs);

  while (cursorDayStartUtc < endMs) {
    const wib = new Date(cursorDayStartUtc + WIB_OFFSET_MS);
    const dow = wib.getUTCDay(); // 0=Min, 6=Sab (dalam frame WIB)
    if (dow >= 1 && dow <= 5) {
      const windowStart = cursorDayStartUtc + BUSINESS_START_HOUR_WIB * 3_600_000;
      const windowEnd = cursorDayStartUtc + BUSINESS_END_HOUR_WIB * 3_600_000;
      const overlapStart = Math.max(startMs, windowStart);
      const overlapEnd = Math.min(endMs, windowEnd);
      if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
    }
    cursorDayStartUtc += 24 * 3_600_000;
  }
  return total;
}

/** Awal hari WIB (00:00 WIB) yang memuat instant ts, dalam epoch-ms UTC. */
function dayStartUtcOfWibDay(ts: number): number {
  const wibTs = ts + WIB_OFFSET_MS;
  const dayStartWib = Math.floor(wibTs / 86_400_000) * 86_400_000;
  return dayStartWib - WIB_OFFSET_MS;
}

/** Jam SLA (sesuai mode) antara start..now. */
export function slaClockMsBetween(start: Date, now: Date, useBusinessHours: boolean): number {
  if (useBusinessHours) return businessMsBetween(start, now);
  const ms = now.getTime() - start.getTime();
  return ms > 0 ? ms : 0;
}

/**
 * Umur SLA dalam ms: clock(slaStartedAt, now) - akumulasi jeda.
 * - slaStartedAt null → null (tidak bisa dihitung; caller fallback ke createdAt).
 * - Saat sedang pause (slaPausedAt != null), jam berhenti di slaPausedAt.
 */
export function slaElapsedMs(
  track: SlaTrackable,
  now: Date,
  config: SlaConfigLike,
): number | null {
  if (!track.slaStartedAt) return null;
  const effectiveNow =
    track.slaPausedAt && track.slaPausedAt.getTime() < now.getTime()
      ? track.slaPausedAt
      : now;
  const clock = slaClockMsBetween(track.slaStartedAt, effectiveNow, config.useBusinessHours);
  const elapsed = clock - toMs(track.slaPausedAccumMs);
  return Math.max(0, elapsed);
}

/** Status SLA dari umur: OK | MENDEKATI (sisa < 20%) | BREACHED. */
export function slaStatus(
  track: SlaTrackable,
  now: Date,
  config: SlaConfigLike,
): SlaStatus {
  const elapsed = slaElapsedMs(track, now, config);
  if (elapsed === null) return 'OK';
  const budgetMs = config.slaHours * 3_600_000;
  if (budgetMs <= 0) return 'OK';
  if (elapsed >= budgetMs) return 'BREACHED';
  const remainingRatio = (budgetMs - elapsed) / budgetMs;
  return remainingRatio < SLA_WARNING_REMAINING_RATIO ? 'MENDEKATI' : 'OK';
}

/** Sisa jam SLA dalam ms (0 bila breached / tidak terhitung). */
export function slaRemainingMs(
  track: SlaTrackable,
  now: Date,
  config: SlaConfigLike,
): number | null {
  const elapsed = slaElapsedMs(track, now, config);
  if (elapsed === null) return null;
  return Math.max(0, config.slaHours * 3_600_000 - elapsed);
}

/**
 * Akumulasi jeda saat resume: tambahkan clock(slaPausedAt, now) ke accum,
 * kembalikan { accumMs, pausedAt: null } untuk di-persist.
 */
export function accumulatePauseOnResume(
  track: SlaTrackable,
  now: Date,
  useBusinessHours: boolean,
): { accumMs: number; pausedAt: null } {
  const accum = toMs(track.slaPausedAccumMs);
  if (!track.slaPausedAt) return { accumMs: accum, pausedAt: null };
  const pausedClock = slaClockMsBetween(track.slaPausedAt, now, useBusinessHours);
  return { accumMs: accum + Math.max(0, pausedClock), pausedAt: null };
}

/** Store minimal untuk baca/tulis config SLA (PrismaService memenuhi ini). */
export interface SlaConfigStore {
  operationalSlaConfig: {
    findUnique(args: {
      where: { scope: string };
    }): Promise<{ slaHours: number; useBusinessHours: boolean } | null>;
    create(args: {
      data: { scope: string; slaHours: number; useBusinessHours: boolean; changeReason?: string };
    }): Promise<{ slaHours: number; useBusinessHours: boolean }>;
  };
}

/**
 * Config efektif per scope — seed default 48 jam kalender saat pertama dibaca.
 * Dipakai AdminKycService & KycSlaMonitorService agar konsisten.
 */
export async function getEffectiveSlaConfig(
  store: SlaConfigStore,
  scope: string,
): Promise<SlaConfigLike> {
  const existing = await store.operationalSlaConfig.findUnique({ where: { scope } });
  if (existing) {
    return { slaHours: existing.slaHours, useBusinessHours: existing.useBusinessHours };
  }
  const created = await store.operationalSlaConfig.create({
    data: {
      scope,
      slaHours: DEFAULT_SLA_HOURS,
      useBusinessHours: false,
      changeReason: 'Seed default: 48 jam kalender',
    },
  });
  return { slaHours: created.slaHours, useBusinessHours: created.useBusinessHours };
}
