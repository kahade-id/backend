/**
 * bounded-concurrency.util.ts — worker-pool sederhana untuk paralelisasi
 * TERBATAS loop `await` berurutan.
 *
 * Dipakai temuan perf B1-006/007/009: loop yang sebelumnya `for ... await`
 * satu-satu diubah menjadi N worker paralel (N = 4..10) tanpa mengubah
 * hasil per item. Urutan hasil = urutan input (seperti loop berurutan).
 *
 * - Kegagalan per item TIDAK menghentikan item lain; error di-capture ke
 *   dalam hasil sebagai `{ ok: false, error }` bila `captureErrors: true`
 *   (default). Bila `captureErrors: false`, error pertama me-reject promise.
 */
export interface BoundedResult<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  opts: { captureErrors?: boolean } = {},
): Promise<BoundedResult<R>[]> {
  const { captureErrors = true } = opts;
  const n = Math.max(1, Math.floor(concurrency));
  const results: BoundedResult<R>[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        if (!captureErrors) throw error;
        results[i] = { ok: false, error };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(n, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Varian hemat memori: jalankan `fn` per item dengan concurrency terbatas
 * tanpa mengumpulkan hasil (untuk loop efek-samping murni, mis. reconcile).
 */
export async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  await mapWithConcurrency(items, concurrency, fn, { captureErrors: false });
}
