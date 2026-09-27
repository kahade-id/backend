/**
 * Kahade — metrik latency & error per route (G482 audit 2026-09-26).
 *
 * In-memory ring buffer TANPA vendor: tiap request yang cocok prefix kunci
 * dicatat (latency, status). Agregasi p50/p95/p99 dihitung on-demand dari
 * sampel mentah (buffer per route dibatasi 1000 sampel — cukup untuk p99
 * yang akurat tanpa unbounded growth).
 *
 * Route kunci yang dicatat (produk keuangan — yang diamati):
 *   login (/v1/auth/*), order (/v1/orders*), wallet (/v1/wallet*),
 *   dispute (/v1/disputes*), chat (/v1/chat*).
 * Rute lain diabaikan agar buffer tidak dipenuhi polling.
 *
 * Catatan privasi: yang disimpan HANYA path ternormalisasi (tanpa query,
 * tanpa path param mentah — `:id` dinormalisasi), method, status, latency.
 */
import { Injectable } from '@nestjs/common';

/** Prefix route kunci yang dicatat. */
export const KEY_ROUTE_PREFIXES = [
  '/v1/auth/',
  '/v1/orders',
  '/v1/wallet',
  '/v1/disputes',
  '/v1/chat',
] as const;

const SAMPLES_PER_ROUTE = 1000;

export interface RouteStats {
  route: string;
  count: number;
  /** Milidetik. */
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  max: number;
  errors: number;
  errorRate: number;
  /** Waktu sampel terakhir (ISO). */
  lastSeenAt: string | null;
  /** Release yang melayani sampel terakhir (APP_VERSION/RELEASE_SHA). */
  release: string | null;
}

interface RouteBucket {
  samples: number[];
  errors: number;
  lastSeenAt: number;
  release: string | null;
}

function normalizePath(path: string): string {
  // Normalisasi path param mentah → :id supaya kardinalitas route terbatas
  // dan tidak ada ID pengguna yang bocor ke label metrik.
  return path
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d{5,}/g, '/:id');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

@Injectable()
export class MetricsService {
  private readonly buckets = new Map<string, RouteBucket>();

  /** Dipanggil interceptor per request yang cocok prefix kunci. */
  recordRequest(rawPath: string, method: string, statusCode: number, latencyMs: number): void {
    const path = normalizePath(rawPath);
    if (!KEY_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) return;
    const route = `${method.toUpperCase()} ${path}`;
    let bucket = this.buckets.get(route);
    if (!bucket) {
      bucket = { samples: [], errors: 0, lastSeenAt: 0, release: null };
      this.buckets.set(route, bucket);
    }
    bucket.samples.push(Math.round(latencyMs));
    if (bucket.samples.length > SAMPLES_PER_ROUTE) bucket.samples.splice(0, bucket.samples.length - SAMPLES_PER_ROUTE);
    if (statusCode >= 500) bucket.errors += 1;
    bucket.lastSeenAt = Date.now();
    bucket.release = process.env.RELEASE_SHA || process.env.APP_VERSION || 'unknown';
  }

  /** Hitung jumlah error 5xx per jendela geser — dipakai detektor alert (G485). */
  countErrorsSince(windowMs: number): { total: number; byRoute: Record<string, number> } {
    // Ring buffer hanya menyimpan agregat error, bukan timestamp per error,
    // sehingga jendela geser presisi tidak tersedia di sini. Detektor alert
    // memakai ErrorSpikeTracker tersendiri (di bawah) yang menyimpan
    // timestamp error. Fungsi ini dipertahankan untuk kompatibilitas.
    void windowMs;
    const byRoute: Record<string, number> = {};
    let total = 0;
    for (const [route, bucket] of this.buckets) {
      byRoute[route] = bucket.errors;
      total += bucket.errors;
    }
    return { total, byRoute };
  }

  getRouteStats(routeFilter?: string): RouteStats[] {
    const out: RouteStats[] = [];
    for (const [route, bucket] of this.buckets) {
      if (routeFilter && !route.includes(routeFilter)) continue;
      const sorted = [...bucket.samples].sort((a, b) => a - b);
      const count = sorted.length;
      const sum = sorted.reduce((a, b) => a + b, 0);
      out.push({
        route,
        count,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        avg: count ? Math.round(sum / count) : 0,
        max: count ? sorted[sorted.length - 1] : 0,
        errors: bucket.errors,
        errorRate: count ? bucket.errors / count : 0,
        lastSeenAt: bucket.lastSeenAt ? new Date(bucket.lastSeenAt).toISOString() : null,
        release: bucket.release,
      });
    }
    return out.sort((a, b) => b.count - a.count);
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Pelacak lonjakan error dengan timestamp (jendela geser presisi) untuk
 * detektor alert G485. Terpisah dari MetricsService karena kebutuhan
 * agregat-vs-timestamp berbeda.
 */
@Injectable()
export class ErrorSpikeTracker {
  /** key → daftar timestamp error (ms epoch). */
  private readonly events = new Map<string, number[]>();

  record(key: string, at = Date.now()): void {
    const list = this.events.get(key) ?? [];
    list.push(at);
    this.events.set(key, list);
  }

  /** Jumlah event dalam jendela [now-windowMs, now]; entri tua dipangkas. */
  countSince(key: string, windowMs: number, now = Date.now()): number {
    const list = this.events.get(key);
    if (!list || list.length === 0) return 0;
    const cutoff = now - windowMs;
    let i = 0;
    while (i < list.length && list[i] < cutoff) i++;
    if (i > 0) list.splice(0, i);
    return list.length;
  }

  /** Dipakai test sintetis G500. */
  clear(key?: string): void {
    if (key) this.events.delete(key);
    else this.events.clear();
  }
}
