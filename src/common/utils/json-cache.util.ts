/**
 * json-cache.util.ts — serialisasi aman untuk nilai cache Redis yang memuat
 * tipe non-JSON Prisma: `Date` dan `bigint`.
 *
 * `JSON.stringify` biasa gagal pada `bigint` (throw) dan mengubah `Date`
 * menjadi string ISO yang tidak bisa dibedakan dari string biasa saat
 * parse. Util ini membungkus keduanya dengan marker `$date` / `$bigint`
 * supaya round-trip bit-identik.
 *
 * Dipakai temuan perf B1-001 (cache pool feed "Untuk Anda").
 */
const DATE_MARKER = '$date';
const BIGINT_MARKER = '$bigint';

export function toStorable(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_MARKER]: value.toISOString() };
  if (typeof value === 'bigint') return { [BIGINT_MARKER]: value.toString() };
  if (Array.isArray(value)) return value.map(toStorable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toStorable(v);
    }
    return out;
  }
  return value;
}

export function fromStorable<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => fromStorable(v)) as T;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj[DATE_MARKER] === 'string') {
      return new Date(obj[DATE_MARKER] as string) as T;
    }
    if (keys.length === 1 && typeof obj[BIGINT_MARKER] === 'string') {
      return BigInt(obj[BIGINT_MARKER] as string) as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = fromStorable(v);
    return out as T;
  }
  return value as T;
}

/** stringify stabil (key terurut) untuk hashing — keyed cache per filter. */
export function stableStringify(value: unknown): string {
  const storable = toStorable(value);
  return stableOf(storable);
}

function stableOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableOf).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableOf(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
