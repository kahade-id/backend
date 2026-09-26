import { resolveDeliveryDeadlineAt, parseDateBoundaryWIB } from './date.util';

describe('resolveDeliveryDeadlineAt (T3 audit 2026-09-26)', () => {
  it('keeps the user-picked explicit date when it is still in the future', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    expect(resolveDeliveryDeadlineAt(future, 3)).toBe(future);
  });

  it('falls back to days when the explicit date is stale', () => {
    const past = new Date(Date.now() - 1000);
    const before = Date.now();
    const res = resolveDeliveryDeadlineAt(past, 3);
    const diffDays = (res.getTime() - before) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(2.9);
    expect(diffDays).toBeLessThanOrEqual(3.1);
  });

  it('falls back to days when no explicit date was given', () => {
    const res = resolveDeliveryDeadlineAt(null, 7);
    const diffDays = (res.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });
});

describe('parseDateBoundaryWIB for calendar dates', () => {
  it('treats a bare YYYY-MM-DD as end-of-day WIB when boundary is end', () => {
    const res = parseDateBoundaryWIB('2026-10-05', 'end');
    expect(res).toBeDefined();
    // 2026-10-05 23:59:59.999 WIB = 2026-10-05T16:59:59.999Z
    expect(res!.toISOString()).toBe('2026-10-05T16:59:59.999Z');
  });

  it('returns undefined for an invalid date', () => {
    expect(parseDateBoundaryWIB('not-a-date', 'end')).toBeUndefined();
  });
});
