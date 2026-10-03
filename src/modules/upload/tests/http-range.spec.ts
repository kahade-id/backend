/**
 * UPV-01 (audit upload video 2026-10-03): parse header HTTP Range untuk
 * download file privat (206 Partial Content).
 */
import { parseHttpRange } from '../utils/http-range';

describe('parseHttpRange — UPV-01', () => {
  const SIZE = 1000;

  it('tanpa header → null (balas 200 penuh)', () => {
    expect(parseHttpRange(undefined, SIZE)).toBeNull();
    expect(parseHttpRange('', SIZE)).toBeNull();
  });

  it('bytes=0-99 → { start: 0, end: 99 }', () => {
    expect(parseHttpRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
  });

  it('bytes=500- (terbuka) → sampai akhir file', () => {
    expect(parseHttpRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
  });

  it('end melebihi ukuran → di-clamp', () => {
    expect(parseHttpRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('suffix range bytes=-100 → 100 byte terakhir', () => {
    expect(parseHttpRange('bytes=-100', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('start di luar ukuran → unsatisfiable (balas 416)', () => {
    expect(parseHttpRange('bytes=1000-', SIZE)).toBe('unsatisfiable');
    expect(parseHttpRange('bytes=5000-6000', SIZE)).toBe('unsatisfiable');
  });

  it('format tak dikenal → null (balas 200, bukan 416)', () => {
    expect(parseHttpRange('bytes=0-99,200-299', SIZE)).toBeNull(); // multi-range
    expect(parseHttpRange('items=0-99', SIZE)).toBeNull();
    expect(parseHttpRange('bytes=-', SIZE)).toBeNull();
    expect(parseHttpRange('bytes=abc-def', SIZE)).toBeNull();
  });

  it('size 0 → null', () => {
    expect(parseHttpRange('bytes=0-', 0)).toBeNull();
  });
});
