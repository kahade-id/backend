/**
 * Kahade — trace helper ringan tanpa vendor lock-in (G479/G491 audit 2026-09-26).
 *
 * Mengapa bukan Sentry/OTel SDK:
 *   - Backend SUDAH punya Sentry (`src/instrument.ts`) untuk error tracking.
 *     Modul ini melengkapi dengan *span bisnis* (order.create, payment.charge,
 *     escrow.release, …) yang disimpan di ring buffer in-memory dan diekspos
 *     lewat endpoint observability admin — tanpa menambah ketergantungan
 *     vendor atau biaya ingest per-span.
 *   - API disengaja mirip OTel (`withSpan`) supaya bila nanti butuh OTel
 *     sungguhan, call-site tidak berubah: cukup ganti implementasi fungsi ini.
 *
 * Kebijakan sampling (G491):
 *   - Transaksi GAGAL → selalu direkam 100% (ring buffer 500 span terakhir).
 *   - Transaksi SUKSES volume tinggi → sampling 1% (random).
 *   - Span non-gagal di luar sampling tetap mengembalikan durasi ke pemanggil
 *     bila `attrs` berisi `__returnStats` — tidak, tetap sederhana: durasi
 *     hanya dicatat di span.
 *
 * Korelasi: setiap span membawa `requestId` dari AsyncLocalStorage yang diset
 * RequestIdInterceptor (X-Request-Id end-to-end, G478) bila tersedia.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { requestContext } from '../../prisma/prisma.service';

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  requestId: string | null;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  /** Nama error saja — TANPA stack/message mentah yang bisa mengandung PII. */
  errorName?: string;
  attributes: SpanAttributes;
}

interface TraceStore {
  traceId: string;
  parentSpanId: string | null;
}

/** Konteks trace aktif per alur async. */
export const traceContext = new AsyncLocalStorage<TraceStore>();

/** Probabilitas sampling span sukses (1% — G491). */
const SUCCESS_SAMPLE_RATE = 0.01;

/** Ring buffer span gagal (100%) + sampel span sukses (1%). */
const SPAN_BUFFER_MAX = 500;
const spanBuffer: FinishedSpan[] = [];

/** Baca snapshot span terakhir (paling baru di akhir). Untuk endpoint admin. */
export function getSpanBuffer(): readonly FinishedSpan[] {
  return spanBuffer;
}

/** Jumlah span yang dibuang karena sampling (diagnostik). */
let sampledOutCount = 0;
export function getSamplingStats(): { buffered: number; sampledOut: number; successSampleRate: number } {
  return { buffered: spanBuffer.length, sampledOut: sampledOutCount, successSampleRate: SUCCESS_SAMPLE_RATE };
}

function recordSpan(span: FinishedSpan): void {
  if (span.status === 'error' || Math.random() < SUCCESS_SAMPLE_RATE) {
    spanBuffer.push(span);
    if (spanBuffer.length > SPAN_BUFFER_MAX) spanBuffer.splice(0, spanBuffer.length - SPAN_BUFFER_MAX);
  } else {
    sampledOutCount += 1;
  }
}

/**
 * Jalankan `fn` di dalam span bernama `name`.
 *
 * Aturan atribut (G480/G481 — produk keuangan):
 *   - payment/webhook: HANYA { provider, amount, currency, status, latencyMs }
 *     — tanpa nomor rekening/token/payload mentah.
 *   - upload: { fileKeyHash, size, mime } — tanpa isi file.
 * Pelanggaran aturan ini adalah bug keamanan; `withSpan` tidak memvalidasi
 * otomatis (pola atribut dicek di review), tetapi atribut bertipe objek
 * DITOLAK di sini supaya payload mentah tidak pernah masuk tidak sengaja.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: { setAttribute: (k: string, v: string | number | boolean) => void }) => Promise<T>,
  attributes: SpanAttributes = {},
): Promise<T> {
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined && typeof v === 'object') {
      throw new Error(`withSpan("${name}"): attribute "${k}" must be a scalar — raw payloads are forbidden in spans`);
    }
  }
  const parent = traceContext.getStore();
  const traceId = parent?.traceId ?? randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const startedAt = Date.now();
  const requestId = requestContext.getStore()?.requestId ?? null;
  const mutableAttrs: SpanAttributes = { ...attributes };
  const started = Date.now();
  try {
    const result = await traceContext.run({ traceId, parentSpanId: spanId }, () =>
      fn({ setAttribute: (k, v) => { mutableAttrs[k] = v; } }),
    );
    recordSpan({
      traceId, spanId, parentSpanId: parent?.parentSpanId ?? null,
      name, requestId, startedAt, durationMs: Date.now() - started,
      status: 'ok', attributes: mutableAttrs,
    });
    return result;
  } catch (err) {
    recordSpan({
      traceId, spanId, parentSpanId: parent?.parentSpanId ?? null,
      name, requestId, startedAt, durationMs: Date.now() - started,
      status: 'error',
      errorName: err instanceof Error ? err.name : 'UnknownError',
      attributes: mutableAttrs,
    });
    throw err;
  }
}

/** ID trace aktif (untuk log korelasi), null bila di luar span. */
export function currentTraceId(): string | null {
  return traceContext.getStore()?.traceId ?? null;
}
