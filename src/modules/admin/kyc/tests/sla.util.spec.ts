/**
 * GAP-E (G276–G300): unit test utilitas SLA operasional.
 * Mencakup: jam kalender vs jam kerja (Senin–Jumat 09:00–17:00 WIB),
 * pause/resume (akumulasi), dan ambang status OK/MENDEKATI/BREACHED.
 */
import {
  businessMsBetween,
  slaElapsedMs,
  slaStatus,
  slaRemainingMs,
  accumulatePauseOnResume,
  getEffectiveSlaConfig,
  DEFAULT_SLA_HOURS,
  type SlaConfigLike,
  type SlaTrackable,
} from '../sla.util';

const HOUR = 3_600_000;
/** Senin, 28 Sep 2026 — hari kerja. */
const MON_0900_WIB = new Date('2026-09-28T02:00:00.000Z'); // 09:00 WIB
const MON_1700_WIB = new Date('2026-09-28T10:00:00.000Z'); // 17:00 WIB
/** Sabtu, 26 Sep 2026 — akhir pekan. */
const SAT_0900_WIB = new Date('2026-09-26T02:00:00.000Z');

const CALENDAR_48: SlaConfigLike = { slaHours: 48, useBusinessHours: false };
const BUSINESS_48: SlaConfigLike = { slaHours: 48, useBusinessHours: true };

const track = (startedAt: Date | null, overrides: Partial<SlaTrackable> = {}): SlaTrackable => ({
  slaStartedAt: startedAt,
  slaPausedAt: null,
  slaPausedAccumMs: 0,
  ...overrides,
});

describe('sla.util — jam kalender', () => {
  it('menghitung elapsed = now - slaStartedAt', () => {
    const start = new Date('2026-09-26T10:00:00.000Z');
    const now = new Date('2026-09-26T15:30:00.000Z');
    expect(slaElapsedMs(track(start), now, CALENDAR_48)).toBe(5.5 * HOUR);
  });

  it('slaStartedAt null → elapsed null & status OK', () => {
    const now = new Date();
    expect(slaElapsedMs(track(null), now, CALENDAR_48)).toBeNull();
    expect(slaStatus(track(null), now, CALENDAR_48)).toBe('OK');
    expect(slaRemainingMs(track(null), now, CALENDAR_48)).toBeNull();
  });
});

describe('sla.util — jam kerja (Senin–Jumat 09:00–17:00 WIB)', () => {
  it('satu hari kerja penuh = 8 jam', () => {
    expect(businessMsBetween(MON_0900_WIB, MON_1700_WIB)).toBe(8 * HOUR);
  });

  it('akhir pekan = 0 jam', () => {
    const sun0900Wib = new Date('2026-09-27T02:00:00.000Z');
    expect(businessMsBetween(SAT_0900_WIB, sun0900Wib)).toBe(0);
    // Jumat 17:00 WIB → Senin 09:00 WIB: tidak ada jam kerja di antaranya.
    const fri1700Wib = new Date('2026-09-25T10:00:00.000Z');
    expect(businessMsBetween(fri1700Wib, MON_0900_WIB)).toBe(0);
  });

  it('memotong di luar jendela 09:00–17:00', () => {
    // Senin 08:00–10:00 WIB → hanya 09:00–10:00 yang dihitung.
    const start = new Date('2026-09-28T01:00:00.000Z');
    const end = new Date('2026-09-28T03:00:00.000Z');
    expect(businessMsBetween(start, end)).toBe(1 * HOUR);
  });

  it('rentang menginap dihitung per irisan harian', () => {
    // Senin 16:00 WIB → Selasa 10:00 WIB = 1 jam + 1 jam.
    const start = new Date('2026-09-28T09:00:00.000Z'); // Senin 16:00 WIB
    const end = new Date('2026-09-29T03:00:00.000Z'); // Selasa 10:00 WIB
    expect(businessMsBetween(start, end)).toBe(2 * HOUR);
  });

  it('end <= start → 0', () => {
    expect(businessMsBetween(MON_1700_WIB, MON_0900_WIB)).toBe(0);
    expect(businessMsBetween(MON_0900_WIB, MON_0900_WIB)).toBe(0);
  });

  it('slaElapsedMs memakai jam kerja bila useBusinessHours', () => {
    // Mulai Jumat 16:00 WIB, cek Senin 10:00 WIB: hanya 1h (Jum 16–17) + 1h (Sen 09–10).
    const start = new Date('2026-09-25T09:00:00.000Z'); // Jumat 16:00 WIB
    const now = new Date('2026-09-28T03:00:00.000Z'); // Senin 10:00 WIB
    expect(slaElapsedMs(track(start), now, BUSINESS_48)).toBe(2 * HOUR);
    // Mode kalender untuk rentang yang sama = 66 jam.
    expect(slaElapsedMs(track(start), now, CALENDAR_48)).toBe(66 * HOUR);
  });
});

describe('sla.util — pause & resume', () => {
  it('jam berhenti saat pause (dihitung sampai slaPausedAt)', () => {
    const start = new Date('2026-09-26T00:00:00.000Z');
    const pausedAt = new Date('2026-09-26T10:00:00.000Z');
    const now = new Date('2026-09-26T20:00:00.000Z');
    expect(slaElapsedMs(track(start, { slaPausedAt: pausedAt }), now, CALENDAR_48)).toBe(10 * HOUR);
  });

  it('resume mengakumulasi jeda dalam satuan jam SLA', () => {
    const pausedAt = new Date('2026-09-26T10:00:00.000Z');
    const now = new Date('2026-09-26T20:00:00.000Z');
    const { accumMs, pausedAt: cleared } = accumulatePauseOnResume(
      track(null, { slaPausedAt: pausedAt, slaPausedAccumMs: 2 * HOUR }),
      now,
      false,
    );
    expect(accumMs).toBe(12 * HOUR); // 2 jam lama + 10 jam jeda
    expect(cleared).toBeNull();
  });

  it('jeda di luar jam kerja menambah 0 pada mode jam kerja', () => {
    // Pause Sabtu 10:00 WIB → resume Senin 08:00 WIB: 0 jam kerja terlewati.
    const pausedAt = new Date('2026-09-26T03:00:00.000Z');
    const now = new Date('2026-09-28T01:00:00.000Z');
    const { accumMs } = accumulatePauseOnResume(
      track(null, { slaPausedAt: pausedAt, slaPausedAccumMs: 0 }),
      now,
      true,
    );
    expect(accumMs).toBe(0);
  });

  it('resume tanpa pause sebelumnya → accum tidak berubah', () => {
    const now = new Date();
    const { accumMs } = accumulatePauseOnResume(
      track(null, { slaPausedAccumMs: 5 * HOUR }),
      now,
      false,
    );
    expect(accumMs).toBe(5 * HOUR);
  });

  it('elapsed setelah resume = clock - akumulasi', () => {
    const start = new Date('2026-09-26T00:00:00.000Z');
    const now = new Date(start.getTime() + 30 * HOUR); // 30 jam kemudian
    // Pernah pause 10 jam → umur efektif 20 jam.
    expect(
      slaElapsedMs(track(start, { slaPausedAccumMs: 10 * HOUR }), now, CALENDAR_48),
    ).toBe(20 * HOUR);
  });

  it('menerima slaPausedAccumMs sebagai BigInt (dari Prisma)', () => {
    const start = new Date('2026-09-26T00:00:00.000Z');
    const now = new Date('2026-09-26T10:00:00.000Z');
    expect(
      slaElapsedMs(track(start, { slaPausedAccumMs: BigInt(2 * HOUR) }), now, CALENDAR_48),
    ).toBe(8 * HOUR);
  });
});

describe('sla.util — ambang status', () => {
  const start = new Date('2026-09-26T00:00:00.000Z');

  it('OK bila sisa >= 20%', () => {
    const now = new Date(start.getTime() + 38 * HOUR); // sisa 10 jam (20.8%)
    expect(slaStatus(track(start), now, CALENDAR_48)).toBe('OK');
  });

  it('MENDEKATI bila sisa < 20%', () => {
    const now = new Date(start.getTime() + 38.5 * HOUR); // sisa 9.5 jam (19.8%)
    expect(slaStatus(track(start), now, CALENDAR_48)).toBe('MENDEKATI');
  });

  it('BREACHED bila elapsed >= budget', () => {
    const now = new Date(start.getTime() + 48 * HOUR);
    expect(slaStatus(track(start), now, CALENDAR_48)).toBe('BREACHED');
    const later = new Date(start.getTime() + 100 * HOUR);
    expect(slaStatus(track(start), later, CALENDAR_48)).toBe('BREACHED');
  });

  it('slaRemainingMs tidak pernah negatif', () => {
    const now = new Date(start.getTime() + 100 * HOUR);
    expect(slaRemainingMs(track(start), now, CALENDAR_48)).toBe(0);
  });
});

describe('sla.util — getEffectiveSlaConfig', () => {
  it('mengembalikan config yang sudah ada tanpa seed', async () => {
    const store = {
      operationalSlaConfig: {
        findUnique: jest.fn().mockResolvedValue({ slaHours: 24, useBusinessHours: true }),
        create: jest.fn(),
      },
    };
    const config = await getEffectiveSlaConfig(store, 'KYC_PERSONAL');
    expect(config).toEqual({ slaHours: 24, useBusinessHours: true });
    expect(store.operationalSlaConfig.create).not.toHaveBeenCalled();
  });

  it('seed default 48 jam kalender saat pertama dibaca', async () => {
    const store = {
      operationalSlaConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ slaHours: 48, useBusinessHours: false }),
      },
    };
    const config = await getEffectiveSlaConfig(store, 'BUSINESS_VERIFICATION');
    expect(config).toEqual({ slaHours: DEFAULT_SLA_HOURS, useBusinessHours: false });
    expect(store.operationalSlaConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'BUSINESS_VERIFICATION',
        slaHours: 48,
        useBusinessHours: false,
      }),
    });
  });
});
