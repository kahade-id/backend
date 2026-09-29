import { toStorable, fromStorable, stableStringify } from './json-cache.util';

describe('json-cache round-trip', () => {
  it('Date dan bigint kembali identik', () => {
    const original = {
      id: 'abc',
      createdAt: new Date('2026-09-29T10:00:00.123Z'),
      priceMin: BigInt(150000),
      priceMax: null,
      user: { name: 'x', joinedAt: new Date('2026-01-01T00:00:00Z') },
      images: [{ url: 'u', sortOrder: 1 }],
    };
    const revived = fromStorable<typeof original>(JSON.parse(JSON.stringify(toStorable(original))));
    expect(revived.createdAt).toEqual(original.createdAt);
    expect(revived.createdAt).toBeInstanceOf(Date);
    expect(revived.priceMin).toBe(BigInt(150000));
    expect(typeof revived.priceMin).toBe('bigint');
    expect(revived.priceMax).toBeNull();
    expect(revived.user.joinedAt).toBeInstanceOf(Date);
    expect(revived.images).toEqual(original.images);
  });

  it('string biasa yang mirip ISO tidak diubah jadi Date', () => {
    const original = { note: '2026-09-29T10:00:00.000Z' };
    const revived = fromStorable<typeof original>(JSON.parse(JSON.stringify(toStorable(original))));
    expect(revived.note).toBe('2026-09-29T10:00:00.000Z');
    expect(typeof revived.note).toBe('string');
  });
});

describe('stableStringify', () => {
  it('urutan key tidak mempengaruhi hash', () => {
    const a = stableStringify({ z: 1, a: { y: 2, b: 3 } });
    const b = stableStringify({ a: { b: 3, y: 2 }, z: 1 });
    expect(a).toBe(b);
  });

  it('nilai berbeda -> string berbeda; Date & bigint aman', () => {
    const a = stableStringify({ d: new Date('2026-09-29T00:00:00Z'), p: BigInt(5) });
    const b = stableStringify({ d: new Date('2026-09-30T00:00:00Z'), p: BigInt(5) });
    expect(a).not.toBe(b);
    expect(() => stableStringify({ p: BigInt(999999999999) })).not.toThrow();
  });
});
