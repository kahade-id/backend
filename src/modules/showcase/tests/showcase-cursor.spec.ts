/**
 * NP-008 (perf-fix, 2026-09-29): unit test keyset cursor untuk list dalam
 * (likers, savers, saved, comments).
 *
 * - round-trip encode/decode;
 * - cursor invalid/ganjil → INVALID_CURSOR (400);
 * - arah keyset desc vs asc benar;
 * - tiebreak (createdAt SAMA, id berbeda) menjaga urutan total — tidak ada
 *   baris yang terlewat atau ganda antarhalaman (disimulasikan in-memory).
 */
import { __cursorTestHooks } from '../showcase.service';

const { encodeNestedCursor, decodeNestedCursor, nestedKeysetWhere } = __cursorTestHooks;

describe('NP-008 nested cursor', () => {
  it('round-trip encode → decode', () => {
    const at = new Date('2026-09-29T10:00:00.000Z');
    const cursor = encodeNestedCursor(at, 'clx123');
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toMatch(/[+/=]/); // base64url, aman di query string
    const decoded = decodeNestedCursor(cursor);
    expect(decoded).toEqual({ t: at.getTime(), i: 'clx123' });
  });

  it.each([
    ['string kosong', ''],
    ['bukan base64', '!!!not-base64!!!'],
    ['JSON valid tapi field salah', Buffer.from(JSON.stringify({ x: 1 }), 'utf8').toString('base64url')],
    ['t bukan number', Buffer.from(JSON.stringify({ t: 'x', i: 'a' }), 'utf8').toString('base64url')],
    ['i kosong', Buffer.from(JSON.stringify({ t: 1, i: '' }), 'utf8').toString('base64url')],
    ['i terlalu panjang', Buffer.from(JSON.stringify({ t: 1, i: 'a'.repeat(65) }), 'utf8').toString('base64url')],
  ])('cursor invalid (%s) → INVALID_CURSOR', (_label, cursor) => {
    expect(() => decodeNestedCursor(cursor)).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'INVALID_CURSOR' }) }),
    );
  });

  it('desc: keyset = (createdAt < t) OR (createdAt = t AND id < i)', () => {
    const where = nestedKeysetWhere({ t: 1000, i: 'm' }, 'desc') as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ createdAt: { lt: new Date(1000) } });
    expect(where.OR[1]).toEqual({ createdAt: new Date(1000), id: { lt: 'm' } });
  });

  it('asc: keyset = (createdAt > t) OR (createdAt = t AND id > i)', () => {
    const where = nestedKeysetWhere({ t: 1000, i: 'm' }, 'asc') as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR[0]).toEqual({ createdAt: { gt: new Date(1000) } });
    expect(where.OR[1]).toEqual({ createdAt: new Date(1000), id: { gt: 'm' } });
  });

  /**
   * Simulasi paginasi penuh in-memory: 25 baris dengan 5 di antaranya
   * berbagi createdAt yang SAMA (tiebreak id), page size 7. Verifikasi:
   * semua baris muncul tepat SEKALI dan urutan global = urutan keyset.
   */
  it.each(['desc', 'asc'] as const)('paginasi %s: tanpa duplikat/lewat, termasuk tiebreak timestamp sama', (direction) => {
    type Row = { id: string; createdAt: number };
    const rows: Row[] = [];
    for (let k = 0; k < 25; k++) {
      // 5 baris pertama berbagi timestamp yang sama.
      const createdAt = k < 5 ? 1_000 : 1_000 + k;
      rows.push({ id: `id-${String(k).padStart(3, '0')}`, createdAt });
    }
    const cmp = (a: Row, b: Row) =>
      direction === 'desc'
        ? b.createdAt - a.createdAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)
        : a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const sorted = [...rows].sort(cmp);

    const pageSize = 7;
    const seen: Row[] = [];
    let cursor: string | null = null;
    for (;;) {
      let pool = sorted;
      if (cursor) {
        const { t, i } = decodeNestedCursor(cursor);
        pool = sorted.filter((r) =>
          direction === 'desc'
            ? r.createdAt < t || (r.createdAt === t && r.id < i)
            : r.createdAt > t || (r.createdAt === t && r.id > i),
        );
      }
      const page = pool.slice(0, pageSize + 1);
      const items = page.slice(0, pageSize);
      seen.push(...items);
      if (page.length <= pageSize) break;
      const last = items[items.length - 1];
      cursor = encodeNestedCursor(new Date(last.createdAt), last.id);
    }
    expect(seen).toHaveLength(25);
    expect(seen.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
    expect(new Set(seen.map((r) => r.id)).size).toBe(25); // tanpa duplikat
  });
});
