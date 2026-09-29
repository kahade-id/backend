import { mapWithConcurrency, forEachWithConcurrency } from './bounded-concurrency.util';

describe('mapWithConcurrency', () => {
  it('hasil sesuai urutan input walau worker selesai acak', async () => {
    const delays = [30, 5, 20, 1, 15];
    const results = await mapWithConcurrency(delays, 3, async (d, i) => {
      await new Promise((r) => setTimeout(r, d));
      return `item-${i}`;
    });
    expect(results.map((r) => r.value)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('tidak pernah melebihi batas concurrency', async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('error per item di-capture tanpa menghentikan item lain', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom-2');
      return n * 10;
    });
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1].ok).toBe(false);
    expect((results[1].error as Error).message).toBe('boom-2');
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });

  it('captureErrors: false -> reject pada error pertama', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async () => {
        throw new Error('fatal');
      }, { captureErrors: false }),
    ).rejects.toThrow('fatal');
  });

  it('array kosong -> hasil kosong tanpa memanggil fn', async () => {
    const fn = jest.fn();
    expect(await mapWithConcurrency([], 5, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('forEachWithConcurrency', () => {
  it('menjalankan efek samping untuk semua item', async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
  });
});
